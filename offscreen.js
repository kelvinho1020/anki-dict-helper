const audio = new Audio();

chrome.runtime.onMessage.addListener((message) => {
	if (message.target !== "offscreen") {
		return;
	}
	audio.src = message.url;
	audio.play().catch(() => {});
});
