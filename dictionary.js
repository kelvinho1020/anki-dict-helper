const CAMBRIDGE_ORIGIN = "https://dictionary.cambridge.org";

function cleanText(node) {
	return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
}

function audioUrl(entry, region) {
	const source = entry.querySelector(`.${region}.dpron-i source`);
	const src = source?.getAttribute("src");
	return src ? new URL(src, CAMBRIDGE_ORIGIN).href : "";
}

function parseSense(block, partOfSpeech) {
	const english = cleanText(block.querySelector(".ddef_h .def"));
	if (!english) {
		return null;
	}
	const example = block.querySelector(".def-body .examp");
	return {
		partOfSpeech,
		phrase: cleanText(block.closest(".phrase-block")?.querySelector(".phrase-title")),
		chinese: cleanText(block.querySelector(".def-body > .trans")),
		english: english.replace(/:$/, ""),
		example: cleanText(example?.querySelector(".eg")),
		exampleChinese: cleanText(example?.querySelector(".trans")),
	};
}

function parseCambridge(html) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const entries = [...doc.querySelectorAll(".pr .entry-body__el")];
	if (entries.length === 0) {
		return null;
	}
	const [first] = entries;
	const ipas = first.querySelectorAll(".pron .ipa");
	const senses = entries.flatMap((entry) => {
		const partOfSpeech = cleanText(entry.querySelector(".posgram"));
		return [...entry.querySelectorAll(".def-block")]
			.map((block) => parseSense(block, partOfSpeech))
			.filter(Boolean);
	});
	if (senses.length === 0) {
		return null;
	}
	return {
		word: cleanText(first.querySelector(".headword")),
		ipaUk: cleanText(ipas[0]),
		ipaUs: cleanText(ipas[1]),
		audioUk: audioUrl(first, "uk"),
		audioUs: audioUrl(first, "us"),
		senses,
	};
}
