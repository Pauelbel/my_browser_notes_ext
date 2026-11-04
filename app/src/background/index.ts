// Service worker: opens the side panel on the toolbar icon.
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);
