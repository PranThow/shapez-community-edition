// shapez CE for iOS: a WKWebView host for the web build in www/.
//
//  - Serves www/ through the shapez://localhost scheme (a secure context, so crypto.randomUUID,
//    workers and the clipboard work) with byte-range support for streamed <audio> music.
//  - shapezIpc (with reply) implements the Electron "fs-job" contract: saves live in
//    Documents/saves and mods in Documents/mods, which the Files app shows under "On My iPhone".
//  - shapezNative: haptics and opening links in Safari.
//  - Saves the game whenever the app leaves the foreground.

#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <WebKit/WebKit.h>

static NSString *const kScheme = @"shapez";
static NSString *const kStartURL = @"shapez://localhost/index.html";
static const unsigned long long kMaxChunk = 1 << 20;     // streamed in 1 MB pieces
static const unsigned long long kOpenRangeCap = 4 << 20; // "bytes=N-" gets at most 4 MB per request

static UIColor *BootColor(void) {
    // Same as the HTML preloader, so there is no flash between launch and first paint
    return [UIColor colorWithRed:0xd5 / 255.0 green:0xd8 / 255.0 blue:0xde / 255.0 alpha:1];
}

#pragma mark - Bundled files

@interface SZSchemeHandler : NSObject <WKURLSchemeHandler>
@property(nonatomic, strong) NSURL *root;
@property(nonatomic, strong) NSHashTable *active; // tasks WebKit has not stopped yet (main thread only)
@property(nonatomic, strong) dispatch_queue_t io;
@end

@implementation SZSchemeHandler

- (instancetype)initWithRoot:(NSURL *)root {
    if ((self = [super init])) {
        _root = root.URLByStandardizingPath;
        _active = [NSHashTable weakObjectsHashTable];
        _io = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
    }
    return self;
}

static NSString *MimeType(NSString *ext) {
    static NSDictionary *types;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
      types = @{
          @"html" : @"text/html; charset=utf-8",
          @"js" : @"text/javascript; charset=utf-8",
          @"css" : @"text/css; charset=utf-8",
          @"json" : @"application/json; charset=utf-8",
          @"png" : @"image/png",
          @"jpg" : @"image/jpeg",
          @"gif" : @"image/gif",
          @"svg" : @"image/svg+xml",
          @"ico" : @"image/x-icon",
          @"woff2" : @"font/woff2",
          @"mp3" : @"audio/mpeg",
          @"webm" : @"video/webm",
      };
    });
    return types[ext.lowercaseString] ?: @"application/octet-stream";
}

- (void)fail:(id<WKURLSchemeTask>)task status:(NSInteger)status {
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:task.request.URL
                                                              statusCode:status
                                                             HTTPVersion:@"HTTP/1.1"
                                                            headerFields:@{@"Content-Length" : @"0"}];
    [task didReceiveResponse:response];
    [task didFinish];
    [self.active removeObject:task];
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    [self.active addObject:task];

    NSString *path = task.request.URL.path ?: @""; // already percent-decoded
    if (path.length == 0 || [path isEqualToString:@"/"]) {
        path = @"/index.html";
    }
    NSURL *file = [self.root URLByAppendingPathComponent:path].URLByStandardizingPath;
    NSString *rootPrefix = [self.root.path stringByAppendingString:@"/"];
    if (![file.path hasPrefix:rootPrefix]) {
        [self fail:task status:403];
        return;
    }

    NSNumber *sizeValue = nil;
    if (![file getResourceValue:&sizeValue forKey:NSURLFileSizeKey error:nil] || sizeValue == nil) {
        [self fail:task status:404];
        return;
    }
    unsigned long long size = sizeValue.unsignedLongLongValue;

    // Byte ranges: AVFoundation streams the 40 minute soundtrack with these
    unsigned long long start = 0, end = size ? size - 1 : 0;
    BOOL ranged = NO;
    NSString *range = [task.request valueForHTTPHeaderField:@"Range"];
    if (range.length > 6 && [range hasPrefix:@"bytes="] && size > 0) {
        NSString *spec = [[range substringFromIndex:6] componentsSeparatedByString:@","].firstObject;
        spec = [spec stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        NSArray<NSString *> *parts = [spec componentsSeparatedByString:@"-"];
        if (parts.count == 2) {
            ranged = YES;
            if (parts[0].length == 0) {
                // Suffix range: the last N bytes
                unsigned long long n = MIN((unsigned long long)parts[1].longLongValue, size);
                start = size - n;
            } else {
                start = (unsigned long long)parts[0].longLongValue;
                if (parts[1].length > 0) {
                    end = MIN((unsigned long long)parts[1].longLongValue, size - 1);
                } else {
                    end = MIN(size - 1, start + kOpenRangeCap - 1);
                }
            }
            if (start >= size || start > end) {
                NSHTTPURLResponse *response =
                    [[NSHTTPURLResponse alloc] initWithURL:task.request.URL
                                                statusCode:416
                                               HTTPVersion:@"HTTP/1.1"
                                              headerFields:@{
                                                  @"Content-Range" : [NSString stringWithFormat:@"bytes */%llu", size],
                                                  @"Content-Length" : @"0",
                                              }];
                [task didReceiveResponse:response];
                [task didFinish];
                [self.active removeObject:task];
                return;
            }
        }
    }

    unsigned long long length = size ? end - start + 1 : 0;
    NSMutableDictionary *headers = [@{
        @"Content-Type" : MimeType(file.pathExtension),
        @"Content-Length" : [NSString stringWithFormat:@"%llu", length],
        @"Accept-Ranges" : @"bytes",
        @"Cache-Control" : @"no-cache",
    } mutableCopy];
    if (ranged) {
        headers[@"Content-Range"] = [NSString stringWithFormat:@"bytes %llu-%llu/%llu", start, end, size];
    }
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:task.request.URL
                                                              statusCode:ranged ? 206 : 200
                                                             HTTPVersion:@"HTTP/1.1"
                                                            headerFields:headers];
    [task didReceiveResponse:response];

    // Read off the main thread; WebKit wants the task callbacks on the main thread
    dispatch_async(self.io, ^{
      NSFileHandle *handle = [NSFileHandle fileHandleForReadingFromURL:file error:nil];
      [handle seekToFileOffset:start];
      unsigned long long remaining = length;
      while (remaining > 0) {
          NSData *chunk = [handle readDataOfLength:(NSUInteger)MIN(remaining, kMaxChunk)];
          if (chunk.length == 0) {
              break;
          }
          remaining -= chunk.length;
          __block BOOL stopped = NO;
          dispatch_sync(dispatch_get_main_queue(), ^{
            if ([self.active containsObject:task]) {
                [task didReceiveData:chunk];
            } else {
                stopped = YES;
            }
          });
          if (stopped) {
              [handle closeFile];
              return;
          }
      }
      [handle closeFile];
      dispatch_async(dispatch_get_main_queue(), ^{
        if ([self.active containsObject:task]) {
            [task didFinish];
            [self.active removeObject:task];
        }
      });
    });
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    [self.active removeObject:task];
}

@end

#pragma mark - Native bridge

@interface SZBridge : NSObject <WKScriptMessageHandlerWithReply, WKScriptMessageHandler, UIDocumentPickerDelegate>
@property(nonatomic, weak) UIViewController *presenter;
@property(nonatomic, strong) NSURL *docsDir;
@property(nonatomic, strong) dispatch_queue_t io;
@property(nonatomic, copy) void (^pickerReply)(id result, NSString *error);
@property(nonatomic, assign) BOOL pickerIsOpen; // open vs. save picker
@property(nonatomic, strong) UIImpactFeedbackGenerator *light, *medium, *rigid;
@property(nonatomic, strong) UISelectionFeedbackGenerator *selection;
@property(nonatomic, strong) UINotificationFeedbackGenerator *notify;
@end

@implementation SZBridge

- (instancetype)init {
    if ((self = [super init])) {
        NSURL *docs = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
        _docsDir = docs;
        _io = dispatch_queue_create("shapez.saves", DISPATCH_QUEUE_SERIAL);
        _light = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
        _medium = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleMedium];
        _rigid = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleRigid];
        _selection = [UISelectionFeedbackGenerator new];
        _notify = [UINotificationFeedbackGenerator new];
    }
    return self;
}

// Storage id -> folder in Documents (visible in the Files app). Only known ids, like Electron.
- (NSURL *)dirFor:(NSString *)storageId {
    NSString *sub = [storageId isEqualToString:@"mods"] ? @"mods" : @"saves";
    return [self.docsDir URLByAppendingPathComponent:sub isDirectory:YES];
}

// Same sanitising as electron/src/fsjob.ts
- (NSURL *)fileFor:(NSString *)name in:(NSURL *)dir {
    NSRegularExpression *unsafe = [NSRegularExpression regularExpressionWithPattern:@"[^a-z.0-9_-]"
                                                                            options:NSRegularExpressionCaseInsensitive
                                                                              error:nil];
    NSString *safe = [unsafe stringByReplacingMatchesInString:name ?: @""
                                                      options:0
                                                        range:NSMakeRange(0, name.length)
                                                 withTemplate:@"_"];
    if (safe.length == 0 || [safe isEqualToString:@"."] || [safe isEqualToString:@".."]) {
        safe = @"_";
    }
    return [dir URLByAppendingPathComponent:safe isDirectory:NO];
}

static NSString *ErrorText(NSError *error, NSString *name) {
    BOOL missing = [error.domain isEqualToString:NSCocoaErrorDomain] &&
                   (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError);
    if (!missing && [error.domain isEqualToString:NSPOSIXErrorDomain] && error.code == ENOENT) {
        missing = YES;
    }
    // FsError reads the code from the third ':'-separated part of the message
    return missing ? [NSString stringWithFormat:@"ENOENT: no such file or directory, open '%@'", name]
                   : [NSString stringWithFormat:@"EIO: %@, '%@'", error.localizedDescription ?: @"i/o error", name];
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id _Nullable, NSString *_Nullable))replyHandler {
    NSDictionary *job = [message.body isKindOfClass:NSDictionary.class] ? message.body : @{};
    NSString *type = job[@"type"];
    NSString *name = [job[@"filename"] isKindOfClass:NSString.class] ? job[@"filename"] : @"";
    void (^reply)(id, NSString *) = ^(id result, NSString *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        replyHandler(result, error);
      });
    };

    if ([type isEqualToString:@"open-external"]) {
        [self presentOpenPicker:reply];
        return;
    }
    if ([type isEqualToString:@"save-external"]) {
        NSString *contents = [job[@"contents"] isKindOfClass:NSString.class] ? job[@"contents"] : @"";
        [self presentSavePicker:name contents:contents reply:reply];
        return;
    }

    NSURL *dir = [self dirFor:[job[@"id"] isKindOfClass:NSString.class] ? job[@"id"] : @"saves"];
    dispatch_async(self.io, ^{
      NSFileManager *fm = NSFileManager.defaultManager;
      NSError *error = nil;
      [fm createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];

      if ([type isEqualToString:@"initialize"]) {
          reply(nil, nil);
      } else if ([type isEqualToString:@"read"]) {
          NSData *data = [NSData dataWithContentsOfURL:[self fileFor:name in:dir] options:0 error:&error];
          data ? reply([data base64EncodedStringWithOptions:0], nil) : reply(nil, ErrorText(error, name));
      } else if ([type isEqualToString:@"write"]) {
          NSData *data = [[NSData alloc] initWithBase64EncodedString:job[@"contents"] ?: @"" options:0];
          if (!data) {
              reply(nil, [NSString stringWithFormat:@"EINVAL: invalid contents, '%@'", name]);
          } else if ([data writeToURL:[self fileFor:name in:dir] options:NSDataWritingAtomic error:&error]) {
              reply(nil, nil);
          } else {
              reply(nil, ErrorText(error, name));
          }
      } else if ([type isEqualToString:@"delete"]) {
          [fm removeItemAtURL:[self fileFor:name in:dir] error:&error] ? reply(nil, nil) : reply(nil, ErrorText(error, name));
      } else if ([type isEqualToString:@"list"]) {
          NSArray *names = [fm contentsOfDirectoryAtPath:dir.path error:&error];
          names ? reply(names, nil) : reply(nil, ErrorText(error, name));
      } else {
          reply(nil, [NSString stringWithFormat:@"EINVAL: unknown fs job type %@", type]);
      }
    });
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    NSDictionary *msg = [message.body isKindOfClass:NSDictionary.class] ? message.body : @{};
    NSString *type = msg[@"type"];
    if ([type isEqualToString:@"haptic"]) {
        NSString *style = msg[@"style"];
        if ([style isEqualToString:@"medium"]) {
            [self.medium impactOccurred];
        } else if ([style isEqualToString:@"rigid"]) {
            [self.rigid impactOccurred];
        } else if ([style isEqualToString:@"selection"]) {
            [self.selection selectionChanged];
        } else if ([style isEqualToString:@"error"]) {
            [self.notify notificationOccurred:UINotificationFeedbackTypeError];
        } else if ([style isEqualToString:@"success"]) {
            [self.notify notificationOccurred:UINotificationFeedbackTypeSuccess];
        } else {
            [self.light impactOccurred];
            [self.light prepare];
        }
    } else if ([type isEqualToString:@"openURL"]) {
        NSURL *url = [NSURL URLWithString:msg[@"url"] ?: @""];
        if ([@[ @"http", @"https", @"mailto" ] containsObject:url.scheme.lowercaseString]) {
            [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
        }
    }
}

#pragma mark Import / export savegames

- (void)finishPicker:(id)result {
    void (^reply)(id, NSString *) = self.pickerReply;
    self.pickerReply = nil;
    if (reply) {
        reply(result, nil);
    }
}

- (void)presentOpenPicker:(void (^)(id, NSString *))reply {
    if (self.pickerReply) {
        reply(nil, nil);
        return;
    }
    self.pickerReply = reply;
    self.pickerIsOpen = YES;
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[ UTTypeItem ] asCopy:YES];
    picker.delegate = self;
    [self.presenter presentViewController:picker animated:YES completion:nil];
}

- (void)presentSavePicker:(NSString *)name contents:(NSString *)contents reply:(void (^)(id, NSString *))reply {
    NSData *data = [[NSData alloc] initWithBase64EncodedString:contents options:0];
    NSString *safe = [[self fileFor:name in:self.docsDir] lastPathComponent];
    NSURL *tmp = [NSFileManager.defaultManager.temporaryDirectory URLByAppendingPathComponent:safe];
    if (!data || self.pickerReply || ![data writeToURL:tmp atomically:YES]) {
        reply(nil, nil);
        return;
    }
    self.pickerReply = reply;
    self.pickerIsOpen = NO;
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initForExportingURLs:@[ tmp ]
                                                                                                  asCopy:YES];
    picker.delegate = self;
    [self.presenter presentViewController:picker animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    if (!self.pickerIsOpen) {
        [self finishPicker:nil];
        return;
    }
    NSURL *url = urls.firstObject;
    BOOL scoped = [url startAccessingSecurityScopedResource];
    NSData *data = url ? [NSData dataWithContentsOfURL:url] : nil;
    if (scoped) {
        [url stopAccessingSecurityScopedResource];
    }
    [self finishPicker:[data base64EncodedStringWithOptions:0]];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
    [self finishPicker:nil];
}

@end

#pragma mark - Game view controller

@interface SZGameViewController : UIViewController <WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) SZBridge *bridge;
@property(nonatomic, strong) SZSchemeHandler *assets;
@property(nonatomic, assign) BOOL saving;
@end

@implementation SZGameViewController

- (void)loadView {
    self.bridge = [SZBridge new];
    self.bridge.presenter = self;
    self.assets = [[SZSchemeHandler alloc] initWithRoot:[NSBundle.mainBundle.bundleURL URLByAppendingPathComponent:@"www"]];

    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    [config setURLSchemeHandler:self.assets forURLScheme:kScheme];
    config.allowsInlineMediaPlayback = YES;
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    config.allowsPictureInPictureMediaPlayback = NO;
    config.dataDetectorTypes = WKDataDetectorTypeNone;
    [config.userContentController addScriptMessageHandlerWithReply:self.bridge
                                                      contentWorld:WKContentWorld.pageWorld
                                                              name:@"shapezIpc"];
    [config.userContentController addScriptMessageHandler:self.bridge name:@"shapezNative"];

    WKWebView *web = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    web.navigationDelegate = self;
    web.UIDelegate = self;
    web.opaque = NO;
    web.backgroundColor = BootColor();
    web.allowsLinkPreview = NO;
    web.allowsBackForwardNavigationGestures = NO;
    web.scrollView.scrollEnabled = NO;
    web.scrollView.bounces = NO;
    web.scrollView.delaysContentTouches = NO;
    web.scrollView.pinchGestureRecognizer.enabled = NO;
    web.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    web.scrollView.backgroundColor = BootColor();
    if ([web respondsToSelector:@selector(setUnderPageBackgroundColor:)]) {
        web.underPageBackgroundColor = BootColor();
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    if ([web respondsToSelector:@selector(setInspectable:)]) {
        web.inspectable = YES; // Safari > Develop on a Mac can debug the game
    }
#pragma clang diagnostic pop
    self.webView = web;

    UIView *root = [[UIView alloc] initWithFrame:CGRectZero];
    root.backgroundColor = BootColor();
    web.frame = root.bounds;
    web.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [root addSubview:web];
    self.view = root;

    [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:kStartURL]]];
}

// Phones play landscape; iPads and an unfolded foldable may also go portrait
- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
    if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) {
        return UIInterfaceOrientationMaskAll;
    }
    CGSize size = self.view.window ? self.view.window.bounds.size : self.view.bounds.size;
    return MIN(size.width, size.height) >= 600 ? UIInterfaceOrientationMaskAllButUpsideDown
                                               : UIInterfaceOrientationMaskLandscape;
}

- (void)viewWillTransitionToSize:(CGSize)size withTransitionCoordinator:(id<UIViewControllerTransitionCoordinator>)coordinator {
    [super viewWillTransitionToSize:size withTransitionCoordinator:coordinator];
    [coordinator
        animateAlongsideTransition:nil
                        completion:^(id<UIViewControllerTransitionCoordinatorContext> context) {
                          // Folding / unfolding changes which orientations make sense
                          [self setNeedsUpdateOfSupportedInterfaceOrientations];
                        }];
}

- (BOOL)prefersStatusBarHidden {
    return YES;
}

- (BOOL)prefersHomeIndicatorAutoHidden {
    return YES;
}

// Dragging belts along the edges must not pull down Notification Center or go home
- (UIRectEdge)preferredScreenEdgesDeferringSystemGestures {
    return UIRectEdgeAll;
}

- (void)saveGame {
    if (self.saving) {
        return;
    }
    self.saving = YES;
    UIApplication *app = UIApplication.sharedApplication;
    __block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
    void (^done)(void) = ^{
      self.saving = NO;
      if (task != UIBackgroundTaskInvalid) {
          [app endBackgroundTask:task];
          task = UIBackgroundTaskInvalid;
      }
    };
    task = [app beginBackgroundTaskWithName:@"shapez-save" expirationHandler:done];
    [self.webView callAsyncJavaScript:@"return await window.shapezIOS?.onBackground?.()"
                            arguments:nil
                              inFrame:nil
                       inContentWorld:WKContentWorld.pageWorld
                    completionHandler:^(id result, NSError *error) {
                      done();
                    }];
}

#pragma mark Navigation

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if ([url.scheme isEqualToString:kScheme] || [url.scheme isEqualToString:@"about"] || [url.scheme isEqualToString:@"blob"] ||
        [url.scheme isEqualToString:@"data"]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    // Discord, GitHub, tutorial videos: open outside the game
    [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)action
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
    if (action.request.URL) {
        [UIApplication.sharedApplication openURL:action.request.URL options:@{} completionHandler:nil];
    }
    return nil;
}

// iOS reclaims the web content process under memory pressure; come back instead of showing a blank page
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:kStartURL]]];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptAlertPanelWithMessage:(NSString *)message
                      initiatedByFrame:(WKFrameInfo *)frame
                     completionHandler:(void (^)(void))completionHandler {
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:nil
                                                                   message:message
                                                            preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *a) {
                                              completionHandler();
                                            }]];
    [self presentViewController:alert animated:YES completion:nil];
}

@end

#pragma mark - App lifecycle

@interface SZSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation SZSceneDelegate

- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    UIWindow *window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    window.backgroundColor = BootColor();
    window.rootViewController = [SZGameViewController new];
    [window makeKeyAndVisible];
    self.window = window;
}

- (SZGameViewController *)game {
    return (SZGameViewController *)self.window.rootViewController;
}

// App switcher, Control Center, a call: save early while we still run at full speed
- (void)sceneWillResignActive:(UIScene *)scene {
    [self.game saveGame];
}

- (void)sceneDidEnterBackground:(UIScene *)scene {
    [self.game saveGame];
}

@end

@interface SZAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation SZAppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    // Follow the silent switch and mix with music that is already playing
    [AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryAmbient error:nil];
    return YES;
}

@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(SZAppDelegate.class));
    }
}
