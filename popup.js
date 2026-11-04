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

let missingWords = [];

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
	missingWords = [];
	restoreMissing.hidden = true;
	restoreStatus.textContent = "";
}

async function handleCheckAdded() {
	resetRestore();
	checkAdded.disabled = true;
	try {
		const { words, fieldNames } = await callBackground("getRestoreInfo");
		const otherWords = [];
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
			if (state === "missing") {
				missingWords.push(word);
			} else if (state === "otherDeck") {
				otherWords.push(word);
			} else {
				inDeck += 1;
			}
		}
		const other = otherWords.length ? `（${otherWords.join("、")}）` : "";
		restoreStatus.textContent = `共 ${words.length} 個：這個牌組有 ${inDeck} 個，`
			+ `其他牌組有 ${otherWords.length} 個${other}，`
			+ `找不到 ${missingWords.length} 個。`;
		restoreMissing.textContent = `補回找不到的 ${missingWords.length} 個`;
		restoreMissing.hidden = missingWords.length === 0;
	} catch (err) {
		restoreStatus.textContent = `檢查失敗：${err.message}`;
	}
	checkAdded.disabled = false;
}

async function handleRestoreMissing() {
	restoreMissing.disabled = true;
	checkAdded.disabled = true;
	const failed = [];
	for (const [index, word] of missingWords.entries()) {
		restoreStatus.textContent =
			`補回中 ${index + 1} / ${missingWords.length}，請先不要關閉…`;
		try {
			await callBackground("restoreWord", { word });
		} catch (err) {
			failed.push(word);
		}
	}
	const added = missingWords.length - failed.length;
	const deckName = deckSelect.selectedOptions[0]?.textContent ?? "";
	const failure = failed.length
		? `，${failed.length} 個失敗（${failed.join("、")}）`
		: "";
	restoreStatus.textContent = `已補回 ${added} 個到「${deckName}」${failure}。`;
	missingWords = failed;
	restoreMissing.textContent = `重試失敗的 ${failed.length} 個`;
	restoreMissing.hidden = failed.length === 0;
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
