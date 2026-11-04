const ANKI_HOST = "https://ankiuser.net";
const ANKI_WEB_HOST = "https://ankiweb.net";
const LOGIN_URL = `${ANKI_HOST}/account/login`;
const TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_URL = "https://api.mymemory.translated.net/get";
const RESTORED_TAG = "anki-helper-restored";

class NotLoggedInError extends Error {}

class AnkiResponseError extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

function encodeVarint(value) {
	let number = BigInt(value);
	const bytes = [];
	while (number > 127n) {
		bytes.push(Number(number & 127n) | 128);
		number >>= 7n;
	}
	bytes.push(Number(number));
	return bytes;
}

function encodeVarintField(fieldNumber, value) {
	if (!value) {
		return [];
	}
	return [...encodeVarint(fieldNumber << 3), ...encodeVarint(value)];
}

function encodeBytesField(fieldNumber, bytes) {
	return [
		...encodeVarint((fieldNumber << 3) | 2),
		...encodeVarint(bytes.length),
		...bytes,
	];
}

function encodeStringField(fieldNumber, text) {
	return encodeBytesField(fieldNumber, [...new TextEncoder().encode(text)]);
}

function decodeMessage(bytes) {
	const fields = {};
	let offset = 0;
	const readVarint = () => {
		let result = 0n;
		let shift = 0n;
		let byte;
		do {
			byte = bytes[offset];
			offset += 1;
			result |= BigInt(byte & 127) << shift;
			shift += 7n;
		} while (byte & 128);
		return result;
	};
	while (offset < bytes.length) {
		const key = Number(readVarint());
		const fieldNumber = key >> 3;
		const wireType = key & 7;
		let value;
		if (wireType === 0) {
			value = readVarint();
		} else if (wireType === 2) {
			const length = Number(readVarint());
			value = bytes.slice(offset, offset + length);
			offset += length;
		} else if (wireType === 1) {
			offset += 8;
			continue;
		} else if (wireType === 5) {
			offset += 4;
			continue;
		} else {
			throw new Error(`Unsupported wire type ${wireType}`);
		}
		(fields[fieldNumber] ??= []).push(value);
	}
	return fields;
}

function decodeString(bytes) {
	return bytes ? new TextDecoder().decode(bytes) : "";
}

function decodeIdName(bytes) {
	const fields = decodeMessage(bytes);
	return {
		id: String(fields[1]?.[0] ?? 0n),
		name: decodeString(fields[2]?.[0]),
	};
}

function decodeFieldNames(list) {
	return (list ?? []).map((bytes) => decodeString(decodeMessage(bytes)[2]?.[0]));
}

async function callAnki(path, body = [], host = ANKI_HOST) {
	const response = await fetch(`${host}${path}`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/octet-stream" },
		body: new Uint8Array(body),
	});
	if (response.status === 403 || response.redirected) {
		throw new NotLoggedInError();
	}
	if (!response.ok) {
		const detail = (await response.text()).trim().slice(0, 120);
		throw new AnkiResponseError(
			`AnkiWeb ${response.status}（${host}${path}）${detail}`,
			response.status,
		);
	}
	return decodeMessage(new Uint8Array(await response.arrayBuffer()));
}

async function getAnkiInfo() {
	const fields = await callAnki("/svc/editor/get-info-for-adding");
	return {
		notetypes: (fields[1] ?? []).map(decodeIdName),
		decks: (fields[2] ?? []).map(decodeIdName),
		currentDeckId: String(fields[3]?.[0] ?? 0n),
		currentNotetypeId: String(fields[4]?.[0] ?? 0n),
		currentFields: decodeFieldNames(fields[5]),
	};
}

async function getNotetypeFields(notetypeId) {
	const fields = await callAnki(
		"/svc/editor/get-notetype-fields",
		encodeVarintField(1, notetypeId),
	);
	return decodeFieldNames(fields[1]);
}

async function addNote({ front, back, tags }) {
	const settings = await chrome.storage.sync.get([
		"deckId",
		"deckName",
		"notetypeId",
	]);
	let { deckId, deckName, notetypeId } = settings;
	let fieldNames;
	if (deckId && notetypeId) {
		fieldNames = await getNotetypeFields(notetypeId);
	} else {
		const info = await getAnkiInfo();
		deckId = info.currentDeckId;
		notetypeId = info.currentNotetypeId;
		fieldNames = info.currentFields;
		deckName = info.decks.find(({ id }) => id === deckId)?.name;
	}
	const values = fieldNames.map((_, index) => {
		if (index === 0) {
			return front;
		}
		return index === 1 ? back : "";
	});
	const body = [
		...values.flatMap((value) => encodeStringField(1, value)),
		...(tags ? encodeStringField(2, tags) : []),
		...encodeBytesField(3, [
			...encodeVarintField(1, notetypeId),
			...encodeVarintField(2, deckId),
		]),
	];
	await callAnki("/svc/editor/add-or-update", body);
	await verifyInDeck(front, fieldNames[0], deckName);
	return deckName ?? "";
}

function escapeHtml(text) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeSearch(text) {
	return text.replace(/[\\"*_:]/g, "\\$&");
}

async function callWithFallback(path, body) {
	return callAnki(path, body).catch((err) => {
		if (err.status === 404) {
			return callAnki(path, body, ANKI_WEB_HOST);
		}
		throw err;
	});
}

async function searchNoteIds(query) {
	const fields = await callWithFallback(
		"/svc/search/search",
		encodeStringField(1, query),
	);
	const error = decodeString(fields[2]?.[0]);
	if (error) {
		throw new Error(error);
	}
	return (fields[1] ?? []).map((bytes) =>
		String(decodeMessage(bytes)[1]?.[0] ?? 0n),
	);
}

function deckTerm(deckName) {
	return `"deck:${escapeSearch(deckName)}"`;
}

function wordTerms(word, fieldNames) {
	const value = escapeSearch(escapeHtml(word));
	return fieldNames
		.map((name) => `"${escapeSearch(name)}:${value}"`)
		.join(" OR ");
}

async function verifyInDeck(front, fieldName, deckName) {
	if (!deckName || !fieldName) {
		return;
	}
	const term = `"${escapeSearch(fieldName)}:${escapeSearch(front)}"`;
	let found;
	try {
		found = await searchNoteIds(`${deckTerm(deckName)} ${term}`);
	} catch (err) {
		console.warn(err);
		return;
	}
	if (found.length === 0) {
		throw new Error(`AnkiWeb 回應成功，但卡片沒有進「${deckName}」`);
	}
}

async function getRestoreInfo() {
	const { addedWords = [] } = await chrome.storage.local.get("addedWords");
	const { notetypes } = await getAnkiInfo();
	const names = new Set();
	for (const { id } of notetypes) {
		try {
			const [first] = await getNotetypeFields(id);
			if (first) {
				names.add(first);
			}
		} catch (err) {
			if (err instanceof NotLoggedInError) {
				throw err;
			}
			console.warn(err);
		}
	}
	if (names.size === 0) {
		throw new Error("讀不到卡片類型的欄位");
	}
	return { words: addedWords, fieldNames: [...names] };
}

async function checkWord({ word, fieldNames }) {
	const terms = wordTerms(word, fieldNames);
	if ((await searchNoteIds(`(${terms})`)).length === 0) {
		return "missing";
	}
	const { deckName = "" } = await chrome.storage.sync.get("deckName");
	const inDeck = await searchNoteIds(`${deckTerm(deckName)} (${terms})`);
	return inDeck.length > 0 ? "inDeck" : "otherDeck";
}

async function copyWord({ word, fieldNames }) {
	const [noteId] = await searchNoteIds(`(${wordTerms(word, fieldNames)})`);
	if (!noteId) {
		throw new Error("找不到原本的卡片");
	}
	const note = await callWithFallback(
		"/svc/editor/get-note-info",
		encodeVarintField(1, noteId),
	);
	const [front, back] = (note[1] ?? []).map(decodeString);
	const tags = decodeString(note[3]?.[0]);
	await addNote({
		front,
		back: back ?? "",
		tags: [tags, RESTORED_TAG].filter(Boolean).join(" "),
	});
}

async function restoreWord(word) {
	const { text } = await translate(word);
	if (!text) {
		throw new Error("翻譯失敗");
	}
	await addNote({
		front: escapeHtml(word),
		back: `<div><b>[主要翻譯]</b> ${escapeHtml(text)}</div>`,
		tags: RESTORED_TAG,
	});
}

async function translateWithGoogle(text) {
	const params = new URLSearchParams({
		client: "gtx",
		sl: "auto",
		tl: "zh-TW",
		q: text,
	});
	params.append("dt", "t");
	params.append("dt", "bd");
	const response = await fetch(`${TRANSLATE_URL}?${params}`);
	if (!response.ok) {
		throw new Error(`Google ${response.status}`);
	}
	const [segments, dictionary] = await response.json();
	return {
		source: "Google 翻譯",
		text: (segments ?? []).map((segment) => segment?.[0] ?? "").join(""),
		meanings: (dictionary ?? []).map((group) => ({
			partOfSpeech: group?.[0] ?? "",
			entries: (group?.[2] ?? []).map((entry) => ({
				word: entry?.[0] ?? "",
				reverse: entry?.[1] ?? [],
			})),
		})),
	};
}

async function translateWithMyMemory(text) {
	const params = new URLSearchParams({ q: text, langpair: "en|zh-TW" });
	const response = await fetch(`${MYMEMORY_URL}?${params}`);
	if (!response.ok) {
		throw new Error(`MyMemory ${response.status}`);
	}
	const { responseData, responseStatus, responseDetails } =
		await response.json();
	if (responseStatus !== 200) {
		throw new Error(responseDetails || `MyMemory ${responseStatus}`);
	}
	return {
		source: "MyMemory",
		text: responseData?.translatedText ?? "",
		meanings: [],
	};
}

async function translate(text) {
	try {
		const result = await translateWithGoogle(text);
		if (result.text) {
			return result;
		}
	} catch (err) {
		console.warn(err);
	}
	return translateWithMyMemory(text);
}

async function playAudio(url) {
	const contexts = await chrome.runtime.getContexts({
		contextTypes: ["OFFSCREEN_DOCUMENT"],
	});
	if (contexts.length === 0) {
		await chrome.offscreen.createDocument({
			url: "offscreen.html",
			reasons: ["AUDIO_PLAYBACK"],
			justification: "Play word pronunciation",
		});
	}
	await chrome.runtime
		.sendMessage({ target: "offscreen", url })
		.catch(() => {});
}

async function markAdded(word) {
	const { addedWords = [] } = await chrome.storage.local.get("addedWords");
	const key = word.toLowerCase();
	if (!addedWords.includes(key)) {
		await chrome.storage.local.set({ addedWords: [...addedWords, key] });
	}
}

async function isAdded(word) {
	const { addedWords = [] } = await chrome.storage.local.get("addedWords");
	return addedWords.includes(word.toLowerCase());
}

const handlers = {
	translate: ({ text }) => translate(text),
	isAdded: ({ word }) => isAdded(word),
	playAudio: ({ url }) => playAudio(url),
	getAnkiInfo: () => getAnkiInfo(),
	getNotetypeFields: ({ notetypeId }) => getNotetypeFields(notetypeId),
	addNote: async (note) => {
		const deckName = await addNote(note);
		await markAdded(note.word);
		return { deckName };
	},
	getRestoreInfo: () => getRestoreInfo(),
	checkWord: (payload) => checkWord(payload),
	restoreWord: ({ word }) => restoreWord(word),
	copyWord: (payload) => copyWord(payload),
	openLogin: () => chrome.tabs.create({ url: LOGIN_URL }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	const handler = handlers[message.type];
	if (!handler) {
		return false;
	}
	Promise.resolve(handler(message))
		.then((data) => sendResponse({ ok: true, data }))
		.catch((err) => {
			sendResponse({
				ok: false,
				notLoggedIn: err instanceof NotLoggedInError,
				error: err.message,
			});
		});
	return true;
});
