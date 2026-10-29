const ANKI_HOST = "https://ankiuser.net";
const LOGIN_URL = `${ANKI_HOST}/account/login`;
const TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_URL = "https://api.mymemory.translated.net/get";

class NotLoggedInError extends Error {}

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

async function callAnki(path, body = []) {
	const response = await fetch(`${ANKI_HOST}${path}`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/octet-stream" },
		body: new Uint8Array(body),
	});
	if (response.status === 403 || response.redirected) {
		throw new NotLoggedInError();
	}
	if (!response.ok) {
		throw new Error(`AnkiWeb ${response.status}`);
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
	const settings = await chrome.storage.sync.get(["deckId", "notetypeId"]);
	let { deckId, notetypeId } = settings;
	let fieldNames;
	if (deckId && notetypeId) {
		fieldNames = await getNotetypeFields(notetypeId);
	} else {
		const info = await getAnkiInfo();
		deckId = info.currentDeckId;
		notetypeId = info.currentNotetypeId;
		fieldNames = info.currentFields;
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
		await addNote(note);
		await markAdded(note.word);
	},
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
