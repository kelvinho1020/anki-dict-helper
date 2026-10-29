const enabledBox = document.getElementById("enabled");
const account = document.getElementById("account");
const login = document.getElementById("login");
const anki = document.getElementById("anki");
const deckSelect = document.getElementById("deck");
const notetypeSelect = document.getElementById("notetype");
const hint = document.getElementById("hint");

function fillSelect(select, items, selectedId) {
	select.replaceChildren(
		...items.map(({ id, name }) => {
			const option = document.createElement("option");
			option.value = id;
			option.textContent = name;
			option.selected = id === selectedId;
			return option;
		}),
	);
}

async function showFields(notetypeId) {
	const response = await chrome.runtime.sendMessage({
		type: "getNotetypeFields",
		notetypeId,
	});
	const names = response?.data ?? [];
	hint.textContent = names.length >= 2
		? `單字放在「${names[0]}」，解釋放在「${names[1]}」。`
		: "這個卡片類型少於兩個欄位，建議選「Basic」。";
}

async function saveChoice() {
	await chrome.storage.sync.set({
		deckId: deckSelect.value,
		notetypeId: notetypeSelect.value,
	});
}

async function loadAnki() {
	const response = await chrome.runtime.sendMessage({ type: "getAnkiInfo" });
	if (!response?.ok) {
		account.textContent = response?.notLoggedIn
			? "還沒登入。登入一次之後就會記住。"
			: `連不上 AnkiWeb：${response?.error ?? "未知錯誤"}`;
		login.hidden = !response?.notLoggedIn;
		return;
	}
	const info = response.data;
	const saved = await chrome.storage.sync.get(["deckId", "notetypeId"]);
	const deckId = saved.deckId ?? info.currentDeckId;
	const notetypeId = saved.notetypeId ?? info.currentNotetypeId;
	account.textContent = "已登入。加入的卡片會直接存到 AnkiWeb。";
	fillSelect(deckSelect, info.decks, deckId);
	fillSelect(notetypeSelect, info.notetypes, notetypeId);
	anki.hidden = false;
	await saveChoice();
	await showFields(notetypeSelect.value);
}

chrome.storage.sync.get({ enabled: true }).then(({ enabled }) => {
	enabledBox.checked = enabled;
});

enabledBox.addEventListener("change", () => {
	chrome.storage.sync.set({ enabled: enabledBox.checked });
});

login.addEventListener("click", () => {
	chrome.runtime.sendMessage({ type: "openLogin" });
	window.close();
});

deckSelect.addEventListener("change", saveChoice);

notetypeSelect.addEventListener("change", async () => {
	await saveChoice();
	await showFields(notetypeSelect.value);
});

loadAnki();
