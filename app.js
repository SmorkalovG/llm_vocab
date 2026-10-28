'use strict';

// API должен поддерживать CORS для страницы, открытой из браузера (включая file://).
const MAX_TEXT_LENGTH = 20000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif'
};
const REQUEST_TIMEOUT_MS = 200000;

// const SYSTEM_PROMPT = `Ты — лингвист, специализирующийся на испанском языке и преподавании его как иностранного.
// Извлеки из пользовательского испанского текста лексические единицы: слова, идиомы, устойчивые выражения, возвратные глаголы и типичные глагольные конструкции.
// Для каждой единицы верни объект строго с полями:
// - lexema: строка, форма как в тексте;
// - orig: строка, словарная форма (глагол в инфинитиве, возвратный глагол с -se, существительное в ед. ч., прилагательное в базовой форме);
// - russian: строка, лаконичный русский перевод именно в данном контексте, но в словарной форме как orig(глагол в инфинитиве, возвратный глагол с -se, существительное в ед. ч., прилагательное в базовой форме);
// - rate: один из A1, A2, B1, B2, C1, C2 либо null, если оценить нельзя;
// - ext: boolean, true для брендов, имен собственных, аббревиатур организаций и явно внешних несловарных единиц. Обычные освоенные испанским языком заимствования получают false.
// Правила:
// 1. Устойчивые выражения важнее отдельных составляющих: отдельно верни выражение, отдельно входящие в него слова.
// 2. При нормализации и создании словарной формы устойчивых выражений не ломай их, лучше оставить исходую форму из текста, чем сломать фразеологизм.
// 3. Не повторяй одинаковые словарные единицы с одинаковым смыслом; разные значения в контексте можно возвращать отдельно.
// 4. Включай все уровни, включая простейшие; фильтрация будет в интерфейсе.
// 5. Не придумывай слова, отсутствующие в тексте. Можно включать служебные слова, если они самостоятельны.
// 6. Не считай CEFR точным стандартом: дай разумную приблизительную оценку.
// 7. Верни ТОЛЬКО JSON-массив объектов без Markdown и пояснений.
// 8. Слова очень похожие на английские с точно тем же значением считай простыми, на 2 ступени проще, чем они есть. Например experiencia - experience
// `;
const SYSTEM_PROMPT = `You are a linguist specializing in Spanish and teaching it as a foreign language.

Extract ALL lexical units from the user's Spanish text, including individual words and multi-word expressions (MWEs).

Treat multi-word expressions as first-class vocabulary entries, even when their meaning is compositional rather than idiomatic.

Pay special attention to:

Temporal expressions: desde entonces, de vez en cuando, a partir de ahora.

Adverbial and prepositional phrases: a pesar de, en lugar de, por lo menos, de repente.

Discourse markers and connectors: sin embargo, es decir, por lo tanto, aun así.

Verb constructions and collocations: tener en cuenta, darse cuenta de, echar de menos, llevar a cabo.

Idioms, fixed phrases, and commonly used word combinations.

Extract both the complete expression and its individual component words.

For each unit, return an array with exactly these values:
- string, the form as it appears in the text;
- string, dictionary form (verbs in infinitive, reflexive verbs with -se, singular nouns, adjectives in base form);
- string, concise Russian translation matching the context, dictionary form;
- enum, difficulty of the word, A1, A2, B1, B2, C1, C2, or null if uncertain;
- boolean, true for brands, proper names, organization acronyms, and clearly non-dictionary foreign items. Established Spanish loanwords get false.
Example:
[["tenía","tener","иметь","A1",false],
 ["darse cuenta","","осознавать","B1",false]]

Before producing the output, scan the text for multi-word expressions of 2–6 words, especially temporal phrases, connectors, prepositional phrases, adverbial phrases, and common verb constructions.
Preserve the complete phrase in orig when normalization might distort its meaning.

Rules:
1. Extract idioms or fixed expressions AND their individual component words separately.
2. Preserve idioms when normalizing expressions. If unsure, keep the original form rather than breaking the expression.
3. Deduplicate units with the same dictionary form and meaning. Different contextual meanings may be listed separately.
4. Include all CEFR levels, even the easiest ones. Filtering is handled by the UI.
5. Do not invent words absent from the text. Include function words when they stand alone.
6. CEFR levels are approximate; use reasonable estimates.
7. Return ONLY a JSON array of arrays, without Markdown or explanations.
8. Words closely resembling English words with exactly the same meaning should be rated 2 CEFR levels lower than their normal level (minimum A1). Example: experiencia – experience.`;

const $ = id => document.getElementById(id);
const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
let rows = [];
let activeController = null;
let rowCounter = 0;
let sourceImage = null;

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}
function setBusy(busy) {
  $('analyzeBtn').disabled = busy;
  $('cancelBtn').hidden = !busy || !activeController;
  $('sourceText').disabled = busy;
  $('fileInput').disabled = busy;
  $('removeImageBtn').disabled = busy;
  for (const id of ['apiUrl', 'apiKey', 'model']) $(id).disabled = busy;
}
function visibleRows() {
  const min = levels.indexOf($('minLevel').value);
  return rows.filter(item => (item.rate === null || levels.indexOf(item.rate) >= min) && ($('showExt').checked || !item.ext));
}
function updateSummary() {
  $('summary').textContent = `(${visibleRows().length} показано из ${rows.length})`;
  const selected = rows.filter(item => item.selected).length;
  $('selectionCount').textContent = `Выбрано: ${selected}`;
  $('exportBtn').disabled = selected === 0;
}
function textInput(value, onUpdate, ariaLabel) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('input', () => { onUpdate(input.value); });
  return input;
}
function addCell(tr, content, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (typeof content === 'string') td.textContent = content;
  else td.append(content);
  tr.append(td);
  return td;
}
function render() {
  const body = $('resultBody');
  body.replaceChildren();
  const filtered = visibleRows();
  if (!filtered.length) {
    const tr = document.createElement('tr');
    addCell(tr, rows.length ? 'Нет строк для выбранных фильтров.' : 'Пока нет результатов. Вставь текст и нажми «Разобрать».', 'empty').colSpan = 6;
    body.append(tr);
  }
  for (const item of filtered) {
    const tr = document.createElement('tr');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = item.selected;
    check.setAttribute('aria-label', `Выбрать ${item.orig}`);
    check.addEventListener('change', () => { item.selected = check.checked; updateSummary(); });
    addCell(tr, check, 'center');
    addCell(tr, item.lexema);
    addCell(tr, textInput(item.orig, value => { item.orig = value; }, 'Словарная форма'));
    addCell(tr, textInput(item.russian, value => { item.russian = value; }, 'Перевод'));
    const rate = document.createElement('select');
    for (const value of ['', ...levels]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || '—';
      rate.append(option);
    }
    rate.value = item.rate || '';
    rate.setAttribute('aria-label', 'Уровень CEFR');
    rate.addEventListener('change', () => { item.rate = rate.value || null; render(); });
    addCell(tr, rate);
    const external = document.createElement('input');
    external.type = 'checkbox';
    external.checked = item.ext;
    external.setAttribute('aria-label', 'Внешний элемент');
    external.addEventListener('change', () => { item.ext = external.checked; render(); });
    addCell(tr, external, 'center');
    body.append(tr);
  }
  updateSummary();
}

function decodeRow(row) {
  if (!Array.isArray(row) || row.length !== 5) {
    throw new Error("Invalid row");
  }

  const [lexema, orig, russian, rate, ext] = row;

  return {
    lexema,
    orig: orig || lexema,
    russian,
    rate,
    ext
  };
}

function decodeModelResponse(data) {
  // Common OpenAI-compatible Chat Completions responses.
  let content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.filter(p => p?.type === 'text').map(p => p.text).join('');
  if (typeof content !== 'string') throw new Error('API не вернул текст choices[0].message.content.');
  let jsonText = content.trim();
  // Fallback for models that mistakenly wrap JSON in a code fence.
  const fence = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) jsonText = fence[1];
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch { throw new Error('Модель вернула невалидный JSON. Повтори запрос или настрой модель на JSON-ответ.'); }
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.items)) parsed = parsed.items;
  if (!Array.isArray(parsed)) throw new Error('Ожидался JSON-массив лексем.');
  const output = [];
  const seen = new Set();
  let invalid = 0;
  for (const raw_arr of parsed) {
    const raw = decodeRow(raw_arr);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.lexema !== 'string' || typeof raw.orig !== 'string' || typeof raw.russian !== 'string' || typeof raw.ext !== 'boolean' || !(raw.rate === null || levels.includes(raw.rate))) {
      invalid++;
      continue;
    }
    const lexema = raw.lexema.trim();
    const orig = raw.orig.trim();
    const russian = raw.russian.trim();
    if (!lexema || !orig || !russian) { invalid++; continue; }
    const key = `${orig.toLocaleLowerCase('es')}\u0000${russian.toLocaleLowerCase('ru')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ id: ++rowCounter, lexema, orig, russian, rate: raw.rate, ext: raw.ext, selected: false });
  }
  if (parsed.length && !output.length) throw new Error('JSON получен, но все строки имеют неправильный формат.');
  return { output, invalid };
}
async function analyze() {
  const source = $('sourceText').value.trim();
  if (!source && !sourceImage) { setStatus('Сначала вставь текст или загрузи TXT-файл или изображение.', true); return; }
  if (source.length > MAX_TEXT_LENGTH) { setStatus(`Слишком длинный текст: ${source.length} символов. Лимит: ${MAX_TEXT_LENGTH}.`, true); return; }
  const baseUrl = $('apiUrl').value.trim().replace(/\/+$/, '');
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim();
  if (!baseUrl || !model) { setStatus('Укажи адрес API и модель в настройках.', true); return; }
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const content = sourceImage
    ? [
      { type: 'text', text: source || 'Разбери испанский текст на изображении.' },
      { type: 'image_url', image_url: { url: sourceImage.dataUrl } }
    ]
    : source;
  const controller = new AbortController();
  activeController = controller;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  setBusy(true);
  setStatus(sourceImage ? 'Отправляю изображение в LLM и ожидаю JSON…' : 'Отправляю текст в LLM и ожидаю JSON…');
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content }
        ],
        temperature: 0.1,
        // Не включаем response_format по умолчанию: некоторые совместимые API его не поддерживают.
        stream: false
      }),
      signal: controller.signal
    });
    console.log(response);
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`Ошибка API HTTP ${response.status}${details ? ': ' + details : ''}`);
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('API вернул не JSON-ответ.'); }
    const { output, invalid } = decodeModelResponse(data);
    rows = output;
    render();
    setStatus(`Готово: ${output.length} лексем.${invalid ? ` Пропущено некорректных строк: ${invalid}.` : ''}`);
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'Запрос отменён или превысил лимит времени.'
      : error instanceof TypeError
        ? 'Не удалось подключиться к API. Проверь адрес, доступность сервера и CORS (особенно при открытии HTML через file://).'
        : error.message;
    setStatus(message, true);
  } finally {
    clearTimeout(timeout);
    if (activeController === controller) activeController = null;
    setBusy(false);
  }
}
function downloadTsv() {
  const chosen = rows.filter(row => row.selected && row.orig.trim() && row.russian.trim());
  if (!chosen.length) { setStatus('Нет отмеченных строк с заполненными словами и переводами.', true); return; }
  const clean = text => text.replace(/[\t\r\n]+/g, ' ').trim();
  const contents = '\uFEFF' + chosen.map(item => `${clean(item.orig)}\t${clean(item.russian)}`).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/tab-separated-values;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `spanish_anki_${new Date().toISOString().slice(0, 10)}.tsv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStatus(`Экспортировано ${chosen.length} карточек.`);
}
$('analyzeBtn').addEventListener('click', analyze);
$('cancelBtn').addEventListener('click', () => activeController?.abort());
function readImage(file, mimeType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение. Попробуй загрузить его снова.'));
    reader.onabort = () => reject(new Error('Чтение изображения отменено.'));
    reader.readAsDataURL(file.slice(0, file.size, mimeType));
  });
}
$('removeImageBtn').addEventListener('click', () => {
  sourceImage = null;
  $('imagePreview').removeAttribute('src');
  $('imageName').textContent = '';
  $('imageAttachment').hidden = true;
  setStatus('Изображение удалено.');
});
$('fileInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy(true);
  setStatus('Читаю файл…');
  try {
    const extension = file.name.split('.').pop().toLowerCase();
    const mimeType = Object.values(IMAGE_MIME_TYPES).includes(file.type)
      ? file.type
      : Object.hasOwn(IMAGE_MIME_TYPES, extension) ? IMAGE_MIME_TYPES[extension] : null;
    if (mimeType) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error('Изображение слишком большое. Лимит: 20 МБ.');
      const dataUrl = await readImage(file, mimeType);
      sourceImage = { dataUrl };
      $('imagePreview').src = dataUrl;
      $('imageName').textContent = file.name;
      $('imageAttachment').hidden = false;
    } else {
      if (extension !== 'txt' && file.type !== 'text/plain') throw new Error('Выбери TXT-файл или изображение PNG, JPEG, WebP, GIF.');
      if (file.size > MAX_TEXT_LENGTH * 4) throw new Error('Текстовый файл слишком большой.');
      const content = await file.text();
      if (content.length > MAX_TEXT_LENGTH) throw new Error(`В файле больше ${MAX_TEXT_LENGTH} символов.`);
      $('sourceText').value = content.replace(/^\uFEFF/, '');
    }
    setStatus(`Загружен файл: ${file.name}`);
  } catch (error) { setStatus(error.message, true); }
  finally {
    event.target.value = '';
    setBusy(false);
  }
});
$('minLevel').addEventListener('change', render);
$('showExt').addEventListener('change', render);
$('selectVisibleBtn').addEventListener('click', () => { visibleRows().forEach(item => { item.selected = true; }); render(); });
$('clearSelectedBtn').addEventListener('click', () => { rows.forEach(item => { item.selected = false; }); render(); });
$('exportBtn').addEventListener('click', downloadTsv);
render();
