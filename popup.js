const enabledBox = document.getElementById("enabled");
const doubleClickBox = document.getElementById("double-click");
const account = document.getElementById("account");
const login = document.getElementById("login");
const anki = document.getElementById("anki");
const deckSelect = document.getElementById("deck");
const notetypeSelect = document.getElementById("notetype");
const hint = document.getElementById("hint");
const checkAdded = document.getElementById("check-added");
const restoreMissing = document.getElementById("restore-missing");
const restoreStatus = document.getElementById("restore-status");

let pendingWords = [];
let noteFieldNames = [];

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
		deckName: deckSelect.selectedOptions[0]?.textContent ?? "",
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

chrome.storage.sync
	.get({ enabled: true, doubleClick: true })
	.then(({ enabled, doubleClick }) => {
		enabledBox.checked = enabled;
		doubleClickBox.checked = doubleClick;
	});

enabledBox.addEventListener("change", () => {
	chrome.storage.sync.set({ enabled: enabledBox.checked });
});

doubleClickBox.addEventListener("change", () => {
	chrome.storage.sync.set({ doubleClick: doubleClickBox.checked });
});

async function callBackground(type, payload = {}) {
	const response = await chrome.runtime.sendMessage({ type, ...payload });
	if (response?.ok) {
		return response.data;
	}
	throw new Error(
		response?.notLoggedIn ? "請先登入 AnkiWeb" : response?.error ?? "未知錯誤",
	);
}

function resetRestore() {
	pendingWords = [];
	restoreMissing.hidden = true;
	restoreStatus.textContent = "";
}

function currentDeckName() {
	return deckSelect.selectedOptions[0]?.textContent ?? "";
}

async function handleCheckAdded() {
	resetRestore();
	checkAdded.disabled = true;
	try {
		const { words, fieldNames } = await callBackground("getRestoreInfo");
		noteFieldNames = fieldNames;
		let inDeck = 0;
		for (const [index, word] of words.entries()) {
			restoreStatus.textContent =
				`檢查中 ${index + 1} / ${words.length}，請先不要關閉…`;
			const state = await callBackground("checkWord", {
				word,
				fieldNames,
			}).catch((err) => {
				throw new Error(`「${word}」${err.message}`);
			});
			if (state === "inDeck") {
				inDeck += 1;
			} else {
				pendingWords.push({ word, state });
			}
		}
		const deckName = currentDeckName();
		restoreStatus.textContent =
			`共 ${words.length} 個，「${deckName}」已有 ${inDeck} 個，`
			+ `還缺 ${pendingWords.length} 個。`;
		restoreMissing.textContent =
			`把 ${pendingWords.length} 個加進「${deckName}」`;
		restoreMissing.hidden = pendingWords.length === 0;
	} catch (err) {
		restoreStatus.textContent = `檢查失敗：${err.message}`;
	}
	checkAdded.disabled = false;
}

async function handleRestoreMissing() {
	restoreMissing.disabled = true;
	checkAdded.disabled = true;
	const total = pendingWords.length;
	const deckName = currentDeckName();
	let added = 0;
	try {
		while (pendingWords.length > 0) {
			const [{ word, state }] = pendingWords;
			restoreStatus.textContent =
				`加入中 ${added + 1} / ${total}，請先不要關閉…`;
			await (state === "missing"
				? callBackground("restoreWord", { word })
				: callBackground("copyWord", {
					word,
					fieldNames: noteFieldNames,
				})
			).catch((err) => {
				throw new Error(`「${word}」${err.message}`);
			});
			pendingWords.shift();
			added += 1;
		}
		restoreStatus.textContent =
			`已確認 ${added} 個都進了「${deckName}」。手機同步後就看得到。`;
	} catch (err) {
		restoreStatus.textContent =
			`已加入 ${added} 個，然後停下來了：${err.message}`;
	}
	restoreMissing.textContent = `重試剩下的 ${pendingWords.length} 個`;
	restoreMissing.hidden = pendingWords.length === 0;
	restoreMissing.disabled = false;
	checkAdded.disabled = false;
}

checkAdded.addEventListener("click", handleCheckAdded);
restoreMissing.addEventListener("click", handleRestoreMissing);

login.addEventListener("click", () => {
	chrome.runtime.sendMessage({ type: "openLogin" });
	window.close();
});

deckSelect.addEventListener("change", async () => {
	resetRestore();
	await saveChoice();
});

notetypeSelect.addEventListener("change", async () => {
	resetRestore();
	await saveChoice();
	await showFields(notetypeSelect.value);
});

loadAnki();
