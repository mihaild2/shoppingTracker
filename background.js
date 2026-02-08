chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: 'index.html' });
});

// Listener to handle cross-origin fetch requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchCatalog") {
        fetch(request.url)
            .then(response => response.text())
            .then(html => sendResponse({ success: true, data: html }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep the message channel open for async response
    }
});