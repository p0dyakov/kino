#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface KSDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler>
@property int port;
@property (strong) NSWindow* window;
@end

@implementation KSDelegate

- (void)applicationDidFinishLaunching:(NSNotification*)note {
    NSRect rect = NSMakeRect(0, 0, 1280, 820);
    NSWindowStyleMask mask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
        NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
        NSWindowStyleMaskFullSizeContentView;
    self.window = [[NSWindow alloc] initWithContentRect:rect
        styleMask:mask backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"Kinostream";
    self.window.titlebarAppearsTransparent = YES;
    self.window.titleVisibility = NSWindowTitleHidden;
    self.window.movableByWindowBackground = YES;
    self.window.minSize = NSMakeSize(720, 480);
    self.window.backgroundColor = [NSColor colorWithRed:9/255.0 green:9/255.0 blue:11/255.0 alpha:1];
    // custom chrome: hide the macOS traffic lights — the web nav renders its own close button
    [self.window standardWindowButton:NSWindowCloseButton].hidden = YES;
    [self.window standardWindowButton:NSWindowMiniaturizeButton].hidden = YES;
    [self.window standardWindowButton:NSWindowZoomButton].hidden = YES;

    WKWebViewConfiguration* cfg = [WKWebViewConfiguration new];
    cfg.preferences.elementFullscreenEnabled = YES;
    cfg.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    [cfg.userContentController addScriptMessageHandler:self name:@"kinostream"];
    WKWebView* web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:cfg];
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    web.navigationDelegate = self;
    web.underPageBackgroundColor = self.window.backgroundColor;
#ifdef DEBUG
    if (@available(macOS 13.3, *)) web.inspectable = YES;
#endif
    [self.window.contentView addSubview:web];
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    NSString* url = [NSString stringWithFormat:@"http://127.0.0.1:%d/", self.port];
    [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url]]];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)app {
    return YES;
}

// jetsam kills the web process under memory pressure — without this the view
// just stays a dead white surface forever
- (void)webViewWebContentProcessDidTerminate:(WKWebView*)webView {
    [webView reload];
}

- (void)userContentController:(WKUserContentController*)uc didReceiveScriptMessage:(WKScriptMessage*)msg {
    NSString* action = [msg.body isKindOfClass:[NSDictionary class]] ? msg.body[@"action"]
                     : [msg.body isKindOfClass:[NSString class]] ? msg.body : nil;
    if ([action isEqualToString:@"close"]) [NSApp terminate:nil];
}

- (void)applicationWillTerminate:(NSNotification*)note {
    // engine exits with the app — all state is in-process
}

@end

int runAppShell(int port) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        KSDelegate* d = [KSDelegate new];
        d.port = port;
        [NSApp setDelegate:d];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp run];
    }
    return 0;
}
