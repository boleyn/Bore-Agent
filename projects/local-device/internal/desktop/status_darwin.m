//go:build darwin && !headless

#import <Cocoa/Cocoa.h>
#include <stdatomic.h>
#import <objc/runtime.h>

extern void connectorRequestManagement(void);

static atomic_int windowPID = 0;
void connectorSetWindowPID(int pid) { atomic_store(&windowPID, pid); }

// Ordinary clicks must always expose the menu, including when the settings
// helper is open. Option-click can raise that helper without menu tracking.
@interface ConnectorStatusAction : NSObject
@property(nonatomic, strong) NSStatusItem *item;
@property(nonatomic, strong) NSMenu *menu;
- (void)clicked:(id)sender;
@end
@implementation ConnectorStatusAction
- (void)clicked:(id)sender {
 int pid = atomic_load(&windowPID);
 NSRunningApplication *app = pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
 if (app != nil && (NSApp.currentEvent.modifierFlags & NSEventModifierFlagOption) != 0) {
  [app activateWithOptions:NSApplicationActivateAllWindows];
  [[NSDistributedNotificationCenter defaultCenter] postNotificationName:@"tech.asiainfo.connector.raise-window" object:[NSString stringWithFormat:@"%d", pid]];
  return;
 }
 [self.item popUpStatusItemMenu:self.menu];
}
@end
static ConnectorStatusAction *statusAction;

static BOOL connectorShouldHandleReopen(id delegate, SEL selector, NSApplication *app, BOOL hasVisibleWindows) {
 connectorRequestManagement();
 return NO;
}

void connectorInstallStatusHook(int showDock) {
 dispatch_async(dispatch_get_main_queue(), ^{
  if (showDock && NSApp.delegate != nil) {
   SEL reopen = @selector(applicationShouldHandleReopen:hasVisibleWindows:);
   class_addMethod([NSApp.delegate class], reopen, (IMP)connectorShouldHandleReopen, "B@:@B");
   [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  }
  @try {
   NSStatusItem *item = [(NSObject *)NSApp.delegate valueForKey:@"statusItem"];
   statusAction = [ConnectorStatusAction new];
   statusAction.item = item;
   statusAction.menu = item.menu;
   item.menu = nil;
   item.button.accessibilityLabel = @"伯仁连接器菜单";
   item.button.target = statusAction;
   item.button.action = @selector(clicked:);
   [item.button sendActionOn:NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp];
  } @catch (NSException *exception) {}
 });
}

void connectorSetStatus(int status) {
 dispatch_async(dispatch_get_main_queue(), ^{
  // getlantern/systray v1.2.2 exposes no attributed status title API.
  // Its AppDelegate owns this statusItem; keep the integration scoped here.
  @try {
   NSStatusItem *item = [(NSObject *)NSApp.delegate valueForKey:@"statusItem"];
   NSColor *color = status == 1 ? NSColor.systemGreenColor : status == 2 ? NSColor.systemOrangeColor : status == 3 ? NSColor.systemRedColor : NSColor.systemGrayColor;
   item.button.attributedTitle = [[NSAttributedString alloc] initWithString:@" ●" attributes:@{NSForegroundColorAttributeName:color, NSFontAttributeName:[NSFont systemFontOfSize:10 weight:NSFontWeightMedium]}];
   item.button.imagePosition = NSImageLeft;
  } @catch (NSException *exception) { /* Keep the standard tray functional if the dependency changes. */ }
 });
}
