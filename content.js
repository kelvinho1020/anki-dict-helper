const WORD_PATTERN = /^[A-Za-z][A-Za-z'’-]*(?: [A-Za-z'’-]+){0,2}$/;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const MAX_TEXT = 500;
const PART_OF_SPEECH = {
	noun: "名詞",
	verb: "動詞",
	adjective: "形容詞",
	adverb: "副詞",
	pronoun: "代名詞",
	preposition: "介系詞",
	conjunction: "連接詞",
	interjection: "感嘆詞",
	abbreviation: "縮寫",
	phrase: "片語",
	prefix: "字首",
	suffix: "字尾",
	article: "冠詞",
};
const PANEL_WIDTH = 340;
const GAP = 8;

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
	--bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de;
	--accent: #0b5cad; --accent-fg: #ffffff; --chip: #e7f0fa; --ok: #1a7f37;
	--err: #cf222e; --pick: #f2f7fd;
	font: 14px/1.5 system-ui, "Microsoft JhengHei", "PingFang TC", sans-serif;
	color: var(--fg);
}
@media (prefers-color-scheme: dark) {
	.root {
		--bg: #1f2428; --fg: #e6edf3; --muted: #9da7b3; --line: #3d444d;
		--accent: #4493f8; --accent-fg: #0d1117; --chip: #213450;
		--ok: #3fb950; --err: #f85149; --pick: #22303f;
	}
}
button { font: inherit; cursor: pointer; }
.bubble {
	position: fixed; z-index: 2147483647; width: 30px; height: 30px;
	border: none; border-radius: 50%; background: var(--accent);
	color: var(--accent-fg); font-weight: 700;
	box-shadow: 0 2px 8px rgba(0,0,0,.25);
}
.panel {
	position: fixed; z-index: 2147483647; width: ${PANEL_WIDTH}px;
	max-width: calc(100vw - 16px); max-height: 440px; display: flex;
	flex-direction: column; background: var(--bg); border: 1px solid var(--line);
	border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.2); outline: none;
}
.head {
	display: flex; align-items: center; gap: 8px; padding: 10px 12px;
	border-bottom: 1px solid var(--line);
}
.word { font-size: 18px; font-weight: 700; }
.ipa { color: var(--muted); font-size: 12px; }
.say {
	border: 1px solid var(--line); background: none; color: var(--fg);
	border-radius: 6px; padding: 0 6px; font-size: 12px;
}
.close {
	margin-left: auto; border: none; background: none; color: var(--muted);
	font-size: 18px; line-height: 1;
}
.body { overflow-y: auto; padding: 6px; }
.message { padding: 16px 12px; color: var(--muted); }
.sense {
	display: flex; gap: 8px; padding: 8px 6px; border-radius: 6px;
	cursor: pointer;
}
.sense:hover, .sense.picked { background: var(--pick); }
.sense input { margin-top: 4px; accent-color: var(--accent); }
.chip {
	display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 4px;
	background: var(--chip); color: var(--accent); font-size: 12px;
}
.chinese { font-weight: 600; }
.english { color: var(--muted); font-size: 13px; }
.example { color: var(--muted); font-size: 12px; font-style: italic; }
.foot {
	display: flex; align-items: center; gap: 8px; padding: 10px 12px;
	border-top: 1px solid var(--line);
}
.status { flex: 1; font-size: 12px; color: var(--muted); }
.status.ok { color: var(--ok); }
.status.err { color: var(--err); }
.add {
	border: none; border-radius: 6px; padding: 6px 14px;
	background: var(--accent); color: var(--accent-fg); font-weight: 600;
}
.add:disabled { opacity: .5; cursor: default; }
.original { padding: 8px 6px 4px; color: var(--muted); font-size: 13px; }
.translation { padding: 4px 6px 10px; font-size: 16px; font-weight: 600; }
.notes { padding: 4px 6px; font-size: 12px; color: var(--muted); }
`;

let enabled = true;
let doubleClick = true;
let selection = null;

const host = document.createElement("div");
const shadow = host.attachShadow({ mode: "open" });
const root = document.createElement("div");
root.className = "root";
const style = document.createElement("style");
style.textContent = STYLE;
shadow.append(style, root);

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text) {
		node.textContent = text;
	}
	return node;
}

function cleanText(node) {
	return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
}

function shorten(text) {
	return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function escapeHtml(text) {
	const node = document.createElement("div");
	node.textContent = text;
	return node.innerHTML;
}

async function send(type, payload = {}) {
	try {
		return await chrome.runtime.sendMessage({ type, ...payload });
	} catch (err) {
		return { ok: false, error: "擴充功能已更新，請重新整理這個網頁。" };
	}
}

function mount() {
	if (!host.isConnected) {
		document.documentElement.append(host);
	}
}

function hide() {
	root.replaceChildren();
}

function readSentence(range, word) {
	const block = range.startContainer.parentElement?.closest(
		"p, li, td, dd, blockquote, h1, h2, h3, h4, div",
	);
	const text = cleanText(block);
	const sentences = text.split(/(?<=[.!?])\s+/);
	const found = sentences.find((item) =>
		item.toLowerCase().includes(word.toLowerCase()),
	);
	return (found ?? "").slice(0, 300);
}

function clampLeft(left) {
	const max = window.innerWidth - Math.min(PANEL_WIDTH, window.innerWidth - 16);
	return Math.max(8, Math.min(left, max - 8));
}

function showBubble() {
	mount();
	const { rect } = selection;
	const bubble = element("button", "bubble", "譯");
	bubble.type = "button";
	bubble.setAttribute("aria-label", `查詢「${selection.word}」`);
	bubble.style.left = `${Math.min(rect.right + 4, window.innerWidth - 38)}px`;
	bubble.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 38)}px`;
	bubble.addEventListener("mousedown", (event) => event.preventDefault());
	bubble.addEventListener("click", openPanel);
	root.replaceChildren(bubble);
}

function placePanel(panel) {
	const { rect } = selection;
	panel.style.left = `${clampLeft(rect.left)}px`;
	const below = window.innerHeight - rect.bottom;
	if (below >= 300 || below >= rect.top) {
		panel.style.top = `${rect.bottom + GAP}px`;
		panel.style.maxHeight = `${Math.min(440, below - GAP * 2)}px`;
	} else {
		panel.style.bottom = `${window.innerHeight - rect.top + GAP}px`;
		panel.style.maxHeight = `${Math.min(440, rect.top - GAP * 2)}px`;
	}
}

function buildHead(word, result) {
	const head = element("div", "head");
	head.append(element("span", "word", result?.word || word));
	const voices = [
		["英", result?.ipaUk, result?.audioUk],
		["美", result?.ipaUs, result?.audioUs],
	];
	for (const [label, ipa, url] of voices) {
		if (!ipa && !url) {
			continue;
		}
		if (url) {
			const say = element("button", "say", `${label} ▶`);
			say.type = "button";
			say.setAttribute("aria-label", `播放${label}式發音`);
			say.addEventListener("click", () => send("playAudio", { url }));
			head.append(say);
		}
		if (ipa) {
			head.append(element("span", "ipa", `/${ipa}/`));
		}
	}
	const close = element("button", "close", "×");
	close.type = "button";
	close.setAttribute("aria-label", "關閉");
	close.addEventListener("click", hide);
	head.append(close);
	return head;
}

function buildSense(sense, index, onToggle) {
	const label = element("label", "sense");
	const box = document.createElement("input");
	box.type = "checkbox";
	box.checked = index === 0;
	label.classList.toggle("picked", box.checked);
	box.addEventListener("change", () => {
		label.classList.toggle("picked", box.checked);
		onToggle(index, box.checked);
	});
	const text = element("div");
	const top = element("div");
	const tag = sense.phrase || sense.partOfSpeech;
	if (tag) {
		top.append(element("span", "chip", tag));
	}
	top.append(element("span", "chinese", sense.chinese || sense.english));
	text.append(top);
	if (sense.chinese) {
		text.append(element("div", "english", sense.english));
	}
	if (sense.example) {
		const example = [sense.example, sense.exampleChinese].join(" ");
		text.append(element("div", "example", example.trim()));
	}
	label.append(box, text);
	return label;
}

function buildCardBack(result, senses, sentence) {
	const ipa = [
		result.ipaUk && `英 /${result.ipaUk}/`,
		result.ipaUs && `美 /${result.ipaUs}/`,
	]
		.filter(Boolean)
		.join("　");
	const parts = ipa ? [`<div>${escapeHtml(ipa)}</div>`] : [];
	for (const sense of senses) {
		const tag = sense.phrase || sense.partOfSpeech;
		const lines = [
			`${tag ? `<b>[${escapeHtml(tag)}]</b> ` : ""}${escapeHtml(sense.chinese)}`,
			`<small>${escapeHtml(sense.english)}</small>`,
		];
		if (sense.example) {
			lines.push(
				`<i>${escapeHtml(sense.example)}</i> ${escapeHtml(sense.exampleChinese)}`,
			);
		}
		parts.push(`<div>${lines.join("<br>")}</div>`);
	}
	if (sentence) {
		const word = escapeHtml(result.word);
		const marked = escapeHtml(sentence).replace(
			new RegExp(`\\b(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"),
			"<b>$1</b>",
		);
		parts.push(`<hr><div>${marked}</div>`);
	}
	return parts.join("<br>");
}

function buildFoot(key, getCard, picked) {
	const foot = element("div", "foot");
	const status = element("span", "status");
	const add = element("button", "add", "加入 Anki");
	add.type = "button";

	const setStatus = (text, kind = "") => {
		status.textContent = text;
		status.className = `status ${kind}`;
	};
	const refresh = () => {
		if (!picked || status.classList.contains("err")) {
			return;
		}
		add.disabled = picked.size === 0;
		setStatus(picked.size ? `已選 ${picked.size} 個解釋` : "請勾選要加入的解釋");
	};

	add.addEventListener("click", async () => {
		if (add.dataset.login) {
			send("openLogin");
			return;
		}
		add.disabled = true;
		setStatus("加入中…");
		const response = await send("addNote", { word: key, ...getCard() });
		if (response?.ok) {
			setStatus("已加入，手機同步後就看得到", "ok");
			add.textContent = "已加入";
			return;
		}
		if (response?.notLoggedIn) {
			setStatus("請先登入 AnkiWeb，登入後再按一次", "err");
			add.textContent = "登入 AnkiWeb";
			add.dataset.login = "1";
			add.disabled = false;
			return;
		}
		setStatus(`加入失敗：${response?.error ?? "未知錯誤"}`, "err");
		add.disabled = false;
	});

	send("isAdded", { word: key }).then((response) => {
		if (response?.data) {
			add.textContent = "再加一次";
		}
	});

	foot.append(status, add);
	refresh();
	return { foot, refresh };
}

function buildNotes(source) {
	const notes = element("div", "notes");
	if (source) {
		notes.append(element("div", "source", `來源：${source}`));
	}
	return notes;
}

function meaningsToResult(word, data) {
	const main = data?.text
		? [{
			partOfSpeech: "主要翻譯",
			phrase: "",
			chinese: data.text,
			english: "",
			example: "",
			exampleChinese: "",
		}]
		: [];
	const others = (data?.meanings ?? []).flatMap(({ partOfSpeech, entries }) =>
		entries.slice(0, 6).map((entry) => ({
			partOfSpeech: PART_OF_SPEECH[partOfSpeech] ?? partOfSpeech,
			phrase: "",
			chinese: entry.word,
			english: entry.reverse.slice(0, 4).join(", "),
			example: "",
			exampleChinese: "",
		})),
	);
	if (others.length === 0) {
		return null;
	}
	const senses = [
		...main,
		...others.filter((sense) => sense.chinese !== data.text),
	];
	return { word, ipaUk: "", ipaUs: "", audioUk: "", audioUs: "", senses };
}

function showTranslation(panel, body, text, sentence, response, notes) {
	if (!response?.ok || !response.data?.text) {
		body.replaceChildren(
			element("div", "message", `翻譯失敗：${response?.error ?? "請稍後再試"}`),
			notes,
		);
		return;
	}
	const translation = response.data.text;
	body.replaceChildren(
		element("div", "original", text),
		element("div", "translation", translation),
		notes,
	);
	const context = sentence && sentence !== text ? sentence : "";
	const getCard = () => ({
		front: escapeHtml(text),
		back: [escapeHtml(translation), context && escapeHtml(context)]
			.filter(Boolean)
			.join("<hr>"),
	});
	const { foot } = buildFoot(text, getCard);
	panel.replaceChildren(buildHead(shorten(text)), body, foot);
}

async function openPanel() {
	const { word, sentence } = selection;
	const panel = element("div", "panel");
	panel.tabIndex = -1;
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-label", `「${shorten(word)}」的解釋`);
	const body = element("div", "body");
	body.append(element("div", "message", "查詢中…"));
	panel.append(buildHead(shorten(word)), body);
	placePanel(panel);
	root.replaceChildren(panel);
	panel.focus();

	const translation = await send("translate", { text: word });
	const result = WORD_PATTERN.test(word)
		? meaningsToResult(word, translation?.data)
		: null;
	if (!panel.isConnected) {
		return;
	}
	const notes = buildNotes(translation?.data?.source);
	if (!result) {
		showTranslation(panel, body, word, sentence, translation, notes);
		return;
	}

	const picked = new Set([0]);
	const getCard = () => ({
		front: escapeHtml(result.word),
		back: buildCardBack(
			result,
			result.senses.filter((_, index) => picked.has(index)),
			sentence,
		),
	});
	const { foot, refresh } = buildFoot(result.word, getCard, picked);
	const onToggle = (index, checked) => {
		if (checked) {
			picked.add(index);
		} else {
			picked.delete(index);
		}
		refresh();
	};
	body.replaceChildren(
		...result.senses.map((sense, index) => buildSense(sense, index, onToggle)),
		notes,
	);
	panel.replaceChildren(buildHead(word, result), body, foot);
}

function handleMouseUp(event) {
	if (!enabled || event.composedPath().includes(host)) {
		return;
	}
	const isDoubleClick = event.detail === 2;
	setTimeout(() => {
		const current = window.getSelection();
		const text = (current?.toString() ?? "")
			.replace(/\s+/g, " ")
			.replace(EDGE_PUNCTUATION, "");
		if (!current?.rangeCount || text.length > MAX_TEXT || !/[A-Za-z]/.test(text)) {
			return;
		}
		const range = current.getRangeAt(0);
		selection = {
			word: text,
			rect: range.getBoundingClientRect(),
			sentence: readSentence(range, text),
		};
		if (isDoubleClick && doubleClick) {
			mount();
			openPanel();
			return;
		}
		showBubble();
	}, 0);
}

function handleMouseDown(event) {
	if (!event.composedPath().includes(host)) {
		hide();
	}
}

function handleKeyDown(event) {
	if (event.key === "Escape") {
		hide();
	}
}

chrome.storage.sync
	.get({ enabled: true, doubleClick: true })
	.then((settings) => {
		({ enabled, doubleClick } = settings);
	});

chrome.storage.onChanged.addListener((changes) => {
	if (changes.enabled) {
		enabled = changes.enabled.newValue;
		hide();
	}
	if (changes.doubleClick) {
		doubleClick = changes.doubleClick.newValue;
	}
});

document.addEventListener("mouseup", handleMouseUp);
document.addEventListener("mousedown", handleMouseDown);
document.addEventListener("keydown", handleKeyDown);
window.addEventListener("scroll", hide, { passive: true });
