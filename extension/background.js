// MV3 event page (Firefox runs MV3 backgrounds as non-persistent event pages).
// Skeleton: proves the extension loads and the toolbar button works. The overlay comes next.
browser.action.onClicked.addListener(async (tab) => {
  await browser.action.setBadgeText({ tabId: tab.id, text: 'on' });
});
