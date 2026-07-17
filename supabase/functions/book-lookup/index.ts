// ============================================================
//  ספריית דבורה עומר — Edge Function לשליפת פרטי ספר
//  שם הפונקציה: book-lookup
//
//  מחפשת ספר לפי מספר (מסת״ב / דאנאקוד) או שם, קודם במאגר
//  הספרייה הלאומית (API רשמי וחופשי), ואם אין תוצאה — נופלת
//  חזרה ל-Google Books. מחזירה JSON אחיד לאפליקציה.
//
//  דורש סוד (secret) בשם NLI_API_KEY עם מפתח ה-API של הספרייה הלאומית.
//  (הרשמה למפתח: https://api2.nli.org.il/signup/ )
//
//  קלט (POST JSON): { "q": "<מספר או שם>" }
//  פלט: { found, source, title, author, publisher, year, language, isbn, cover }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const LANG: Record<string, string> = { heb: "עברית", he: "עברית", eng: "אנגלית", en: "אנגלית", ara: "ערבית", ar: "ערבית", rus: "רוסית", fre: "צרפתית", fra: "צרפתית", ger: "גרמנית", spa: "ספרדית" };

// שליפת ערך מרשומת JSON-LD של הספרייה הלאומית לפי חלק משם המפתח
function pick(rec: any, substr: string): string {
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase().includes(substr)) {
      const v = rec[k];
      if (Array.isArray(v) && v.length) return (v[0]["@value"] || v[0]["value"] || v[0] || "").toString();
      if (typeof v === "string") return v;
    }
  }
  return "";
}

// בניית וריאציות חיפוש: מסת"ב, דאנאקוד (בצורותיו), או טקסט חופשי
function candidates(q: string): string[] {
  const digits = q.replace(/[^0-9Xx]/g, "");
  const out: string[] = [];
  const add = (t: string) => { if (t && !out.includes(t)) out.push(t); };
  if (digits.length >= 7) add(digits);
  // דאנאקוד סרוק (12 ספרות, לא מתחיל 978/979): 124500001036 → 1245-103 וגם 1245103
  // סורקים מסוימים בולעים אפסים מובילים (10100302164 במקום 010100302164) — משלימים ל-12 ובודקים גם כך
  let d12 = digits;
  if ((digits.length === 10 || digits.length === 11) && !/^97[89]/.test(digits) && !isValidIsbn(digits)) { d12 = digits.padStart(12, "0"); add(d12); }
  if (d12.length === 12 && !/^97[89]/.test(d12)) {
    const pub = d12.slice(0, 4);
    const mid = d12.slice(4, 11).replace(/^0+/, "");
    const pubT = pub.replace(/^0+/, "");
    if (mid) {
      if (pubT && pubT !== pub) { add(pubT + "-" + mid); add(pubT + mid); }
      add(pub + "-" + mid); add(pub + mid);
    }
  }
  // דאנאקוד שהוקלד ידנית עם מקף (1245-103) — גם המספר הרציף
  if (/^\d{2,5}-\d{1,7}$/.test(q.trim())) { add(q.trim()); add(q.trim().replace("-", "")); }
  // מסת"ב-13 → מסת"ב-10 (לספרים ישנים שמופיעים במאגר רק בצורה הישנה)
  if (digits.length === 13 && /^978/.test(digits)) {
    const core = digits.slice(3, 12);
    let sum = 0; for (let i = 0; i < 9; i++) sum += (10 - i) * (+core[i]);
    let chk = (11 - (sum % 11)) % 11;
    add(core + (chk === 10 ? "X" : String(chk)));
  }
  if (!out.length) add(q.trim());
  return out;
}

const TRIED: string[] = [];
function tri(msg: string) { TRIED.push(msg); if (TRIED.length > 30) TRIED.shift(); console.log(msg); }

async function nliQueryAll(term: string, key: string): Promise<any[]> {
  const query = `any,contains,${term}`;
  const url = `https://api.nli.org.il/openlibrary/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&output_format=json`;
  const r = await fetch(url);
  if (!r.ok) { tri(`NLI "${term}" → http ${r.status}`); return []; }
  const data = await r.json();
  const arr = Array.isArray(data) ? data : (data && data.result ? data.result : []);
  tri(`NLI "${term}" → ${arr.length} תוצאות`);
  return arr;
}

// אימות קפדני: המספר חייב להופיע בשדה מזהה (מסת"ב/דאנא/identifier) כמספר שלם — לא כחלק ממספר ארוך
function idMatch(rec: any, term: string): boolean {
  try {
    const needle = term.replace(/[^0-9Xx-]/g, "");
    if (needle.length < 4) return false;
    const esc = needle.replace(/[-]/g, "\\-");
    const re = new RegExp("(^|[^0-9])" + esc + "([^0-9]|$)");
    const reNoDash = needle.includes("-") ? new RegExp("(^|[^0-9])" + needle.replace(/-/g, "") + "([^0-9]|$)") : null;
    for (const k of Object.keys(rec)) {
      if (!/identifier|isbn|dana|issn|sourcerecordid|control/i.test(k)) continue;
      const v = rec[k];
      const vals: string[] = Array.isArray(v) ? v.map((x: any) => (x && (x["@value"] || x["value"]) || x || "").toString()) : [String(v)];
      for (const s0 of vals) {
        const sv = s0.replace(/[^0-9Xx-]/g, "");
        const svND = sv.replace(/-/g, "");
        if (re.test(sv) || re.test(svND)) return true;
        if (reNoDash && (reNoDash.test(sv) || reNoDash.test(svND))) return true;
      }
    }
  } catch (_) {}
  return false;
}
// ניקוי שדות קטלוגיים גולמיים של הספרייה הלאומית
function cleanNliTitle(t: string): string {
  let x = (t || "").split(" / ")[0].split(" ; ")[0];
  x = x.replace(/[\s.:,;]+$/,"").trim();
  return x;
}
function cleanNliAuthor(a: string): string {
  let x = (a || "").split("$$")[0];
  x = x.replace(/,?\s*\d{4}\s*-\s*(\d{4})?\s*$/,"");   // שנות לידה/פטירה: "חמיצר, גיורא, 1971-" → "חמיצר, גיורא"
  x = x.replace(/\s*(מחבר|מאייר|עורך|עורכת|מתרגם|מתרגמת|יוצר האוסף)\s*$/g, "");
  x = x.replace(/\s*(מחבר|מאייר)\s*(מאייר|מחבר)?\s*$/,"").replace(/[\s.,;]+$/,"").trim();
  return x;
}
async function lookupNLI(q: string, key: string) {
  const terms = candidates(q);
  const digitsQ = q.replace(/[^0-9Xx]/g, "");
  const isNumeric = digitsQ.length >= 7;
  let rec: any = null;
  for (const term of terms) {
    let arr: any[] = [];
    try { arr = await nliQueryAll(term, key); } catch (e) { tri(`NLI "${term}" → שגיאה`); arr = []; }
    if (!arr.length) continue;
    if (!isNumeric) {
      // חיפוש לפי שם — סורקים את התוצאות ובוחרים את זו שהכותר שלה באמת דומה (לא עיוורת את הראשונה)
      const sim = arr.slice(0, 10).find((r0: any) => titleSimilar(q, cleanNliTitle(pick(r0, "title"))));
      if (sim) { tri(`NLI שם "${q.slice(0,30)}" → נמצא כותר דומה ✓`); rec = sim; break; }
      tri(`NLI שם "${q.slice(0,30)}" → אין כותר דומה בתוצאות`);
      continue;
    }
    // חיפוש מספרי — עדיפות 1: אימות מול שדה מזהה
    const pool = arr.slice(0, 10);
    const valid = pool.find((r0: any) => idMatch(r0, term));
    if (valid) { tri(`NLI "${term}" → אומת מול שדה מזהה ✓`); rec = valid; break; }
    // חיפוש דאנאקוד ב-NLI מחזיר התאמות אקראיות (מספרי מערכת) — בלי אימות מזהה, לא לוקחים כלום.
    tri(`NLI "${term}" → אף תוצאה לא אומתה בשדה מזהה, נפסלו`);
  }
  if (!rec) return null;
  const title = pick(rec, "title");
  if (!title) return null;
  const langRaw = pick(rec, "language").toLowerCase().slice(0, 3);
  let cover = pick(rec, "thumbnail") || pick(rec, "nnl_thumbnail") || "";
  // רק מסת"ב שעובר ספרת ביקורת — שדה identifier מכיל לרוב מספר מערכת פנימי, לא מסת"ב
  const isbnRaw = (pick(rec, "isbn") || pick(rec, "identifier")).replace(/[^0-9Xx]/g, "");
  const isbn = isValidIsbn(isbnRaw) ? isbnRaw : "";
  if (!cover && isbn) cover = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
  return {
    found: true, source: "הספרייה הלאומית",
    title: cleanNliTitle(title),
    author: cleanNliAuthor(pick(rec, "creator") || pick(rec, "contributor")),
    publisher: pick(rec, "publisher"),
    year: (pick(rec, "date").match(/\d{4}/) || [""])[0],
    language: LANG[langRaw] || "",
    isbn, cover,
  };
}

async function lookupGoogle(q: string) {
  const digits = q.replace(/[^0-9Xx]/g, "");
  const isIsbn = digits.length >= 10;
  const url = isIsbn
    ? `https://www.googleapis.com/books/v1/volumes?q=isbn:${digits}`
    : `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}`;
  const r = await fetch(url);
  if (!r.ok) { tri(`GoogleBooks → http ${r.status}`); return null; }
  const data = await r.json();
  const v = data.items && data.items[0] && data.items[0].volumeInfo;
  if (!v) { tri(`GoogleBooks → 0 תוצאות`); return null; }
  let cover = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
  if (cover) cover = cover.replace("http://", "https://");
  else if (isIsbn && isValidIsbn(digits)) cover = `https://covers.openlibrary.org/b/isbn/${digits}-L.jpg`;
  return {
    found: true, source: "Google Books",
    title: v.title || "",
    author: (v.authors || []).join(", "),
    publisher: v.publisher || "",
    year: ((v.publishedDate || "").match(/\d{4}/) || [""])[0],
    language: LANG[v.language] || "",
    isbn: isValidIsbn(digits) ? digits : "",
    cover: cover || "",
  };
}

// שכבה 3: חיפוש גוגל אמיתי (Custom Search API) — הופך דאנאקוד לשם ספר
// דורש סודות: GOOGLE_CSE_KEY (מפתח API) + GOOGLE_CSE_ID (מזהה מנוע החיפוש)
function cleanTitleFromWeb(t: string): string {
  let x = (t || "").replace(/["״]/g, "");
  // חיתוך שמות אתרים/זנבות: "יומני החנונית 7 | קידסבסט" → "יומני החנונית 7"
  x = x.split("|")[0].split(" - ")[0].split(" – ")[0];
  x = x.replace(/דאנאקוד.*$/,"").replace(/מחיר.*$/,"").replace(/(\.\.\.|…)\s*$/,"").trim();
  x = x.replace(/\s[\u0590-\u05ffA-Za-z]$/,"").trim();  // אות בודדת תלושה בסוף (קיצוץ של גוגל)
  return x;
}
// דמיון כותרים: ההעשרה מהמאגרים מתקבלת רק אם הכותר שנמצא באמת דומה לשם שחיפשנו
function titleSimilar(query: string, found: string): boolean {
  const tok = (t: string) => (t || "").replace(/[^0-9A-Za-z\u0590-\u05ff ]/g, " ").split(/\s+/).filter(w => w.length >= 3);
  const qs = tok(query), fs = new Set(tok(found));
  if (!qs.length) return false;
  const shared = qs.filter(w => fs.has(w)).length;
  return shared >= 2 || shared / qs.length >= 0.6;
}
async function lookupWebSearch(q: string, cseKey: string, cseCx: string) {
  let digits = q.replace(/[^0-9Xx]/g, "");
  // השלמת אפס מוביל שנבלע בסריקה — כמו ב-candidates
  if ((digits.length === 10 || digits.length === 11) && !/^97[89]/.test(digits) && !isValidIsbn(digits)) digits = digits.padStart(12, "0");
  let term = q, isDana = false;
  if (digits.length === 12 && !/^97[89]/.test(digits)) {
    const pub = digits.slice(0, 4).replace(/^0+/, "");
    const mid = digits.slice(4, 11).replace(/^0+/, "");
    if (pub && mid) { term = pub + "-" + mid; isDana = true; }
  }
  if (!isDana && /^\d{2,5}-\d{1,7}$/.test(q.trim())) isDana = true;   // דאנאקוד שהוקלד ידנית עם מקף
  const SERPER = Deno.env.get("SERPER_API_KEY") || "";
  let items: { title: string; snippet: string; link: string }[] = [];
  if (SERPER) {
    // Serper.dev — תוצאות גוגל אמיתיות, 2,500 חינם
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": SERPER, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `"${term}" ספר`, gl: "il", hl: "iw", num: 5 }),
    });
    if (!r.ok) { let t = ""; try { t = (await r.text()).slice(0, 160).replace(/\s+/g, " "); } catch (_) {}
      tri(`WebSearch(Serper) "${term}" → http ${r.status}${t ? " · " + t : ""}`); return null; }
    const data = await r.json();
    items = (data.organic || []).map((it: any) => ({ title: it.title || "", snippet: it.snippet || "", link: it.link || "" }));
    tri(`WebSearch(Serper) "${term}" → ${items.length} תוצאות`);
  } else if (cseKey && cseCx) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(cseKey)}&cx=${encodeURIComponent(cseCx)}&q=${encodeURIComponent('"' + term + '" ספר')}&num=3`;
    const r = await fetch(url);
    if (!r.ok) { let t = ""; try { t = (await r.text()).slice(0, 160).replace(/\s+/g, " "); } catch (_) {}
      tri(`WebSearch(Google) "${term}" → http ${r.status}${t ? " · " + t : ""}`); return null; }
    const data = await r.json();
    items = (data.items || []).map((it: any) => ({ title: it.title || "", snippet: it.snippet || "", link: it.link || "" }));
    tri(`WebSearch(Google) "${term}" → ${items.length} תוצאות`);
  } else { tri("WebSearch → אין ספק מוגדר"); return null; }

  for (const it of items) {
    // אימות: הדאנאקוד חייב להופיע בתוצאה כמספר שלם — לא כחלק ממספר ארוך יותר.
    // בלי גבולות, "310-229" תופס גם טלפון אמריקאי 310-229-5867 (310 = קידומת לוס אנג'לס).
    // מותר אפסים מובילים ("0310-229" באתר מול "310-229" בחיפוש), אסור ספרות/המשך-מקף אחרי.
    const rawTxt = (it.title || "") + " " + (it.snippet || "");
    const needle = term.replace(/[^0-9-]/g, "");
    if (needle.length >= 4) {
      const pre = "(^|[^0-9])0*", post = "([^0-9-]|$)";
      const reDash = new RegExp(pre + needle.replace(/-/g, "\\-") + post);
      const reFlat = new RegExp(pre + needle.replace(/-/g, "") + post);
      if (!reDash.test(rawTxt) && !reFlat.test(rawTxt)) { tri(`WebSearch → תוצאה בלי הדאנאקוד כמספר שלם, נפסלה`); continue; }
    }
    const title = cleanTitleFromWeb(it.title || "");
    if (!title || title.length < 2) continue;
    // מסנן כותרות שאינן ספרים: גיליונות אקסל, קטלוגים, רשימות מלאי וכו' ("גיליון1" = Sheet1)
    if (/^(גיליון|גליון|sheet|עמוד|page|קטלוג|טבלה|רשימת|רשימה|מלאי|מחירון|catalog|inventory|excel|xls)/i.test(title)) { tri(`WebSearch → כותרת לא-ספרית ("${title.slice(0, 20)}"), נפסלה`); continue; }
    // מסנן מודעות ולוחות יד-שנייה: מודעת רכב עם "ספר טיפולים" עברה את החיפוש. דומיינים + סימני מודעה בכותרת.
    const _lnk = ((it as any).link || "").toLowerCase();
    if (/yad2\.|facebook\.|instagram\.|tiktok\.|olx\.|ebay\.|aliexpress|winwin\.|homeless\.co/.test(_lnk)) { tri(`WebSearch → דומיין לוח מודעות, נפסל`); continue; }
    if (title.length > 45 || /[✅✔☎📞₪🔥❗]|למכירה|\bיד\s*0?\d\b|ק"מ|קילומטר|טסט|תשלומים|טיפולים/.test(title)) { tri(`WebSearch → כותרת נראית כמו מודעה ("${title.slice(0, 20)}…"), נפסלה`); continue; }
    // דאנאקוד = מזהה ישראלי לספר עברי; כותרת בלי אף אות עברית היא תעתיק פונטי מאתר לועזי — נפסלת
    if (isDana && !/[\u0590-\u05FF]/.test(title)) { tri(`WebSearch → כותרת לועזית לדאנאקוד ישראלי ("${title.slice(0, 25)}"), נפסלה`); continue; }
    tri(`WebSearch → מנסה שם: "${title}"`);
    let d: any = null;
    const NLIKEY = Deno.env.get("NLI_API_KEY") || "";
    if (NLIKEY) { try { d = await lookupNLI(title, NLIKEY); } catch (_) {} }
    if (d && !titleSimilar(title, d.title || "")) { tri(`WebSearch → העשרת NLI נפסלה (כותר לא דומה: "${(d.title || "").slice(0, 40)}")`); d = null; }
    if (!d) { try { d = await lookupGoogle(title); } catch (_) {} }
    if (d && !titleSimilar(title, d.title || "")) { tri(`WebSearch → העשרת GoogleBooks נפסלה (כותר לא דומה)`); d = null; }
    const _blob = (it.title || "") + " " + (it.snippet || "");
    let _age = extractAge(_blob);
    const _lf = extractLabeledFields(_blob);
    let _sf = seriesFromSnippet(_blob, title);
    // תוצאה עירומה (אין העשרה ואין מחבר בתקציר) — חיפוש טקסט נוסף לפי השם:
    // תקצירי כמה חנויות יחד מכילים לרוב "מאת ..." / "הוצאה: ..." שהתקציר הבודד פספס
    if (!d && !_lf.author && SERPER) {
      try {
        const r2 = await fetch("https://google.serper.dev/search", {
          method: "POST", headers: { "X-API-KEY": SERPER, "Content-Type": "application/json" },
          body: JSON.stringify({ q: `"${title}" ספר`, gl: "il", hl: "iw", num: 5 }),
        });
        if (r2.ok) {
          const d2 = await r2.json();
          const blob2 = (d2.organic || []).map((o: any) => (o.title || "") + " " + (o.snippet || "")).join(" · ");
          const lf2 = extractLabeledFields(blob2);
          if (lf2.author) _lf.author = lf2.author;
          if (!_lf.publisher && lf2.publisher) _lf.publisher = lf2.publisher;
          if (!_lf.year && lf2.year) _lf.year = lf2.year;
          if (!_age) _age = extractAge(blob2);
          if (!_sf.series) _sf = seriesFromSnippet(blob2, title);
          tri(`WebSearch → העשרה לפי שם: ${[lf2.author && "מחבר✓", lf2.publisher && "הוצאה✓", lf2.year && "שנה✓"].filter(Boolean).join(" ") || "לא נמצאו שדות"}`);
        }
      } catch (_) { tri("WebSearch → העשרה לפי שם נכשלה"); }
    }
    if (_lf.author || _lf.publisher || _lf.year || _sf.series) tri(`WebSearch → שדות מהתקציר: ${[_lf.author && "מחבר✓", _lf.publisher && "הוצאה✓", _lf.year && "שנה✓", _sf.series && "סדרה✓"].filter(Boolean).join(" ")}`);
    if (d) {
      d.title = title;  // השם שנמצא באינטרנט הוא השם המוצג — המאגר רק משלים מחבר/הוצאה/שנה/כריכה
      d.author = cleanNliAuthor(d.author || "") || _lf.author;
      if (!d.publisher) d.publisher = _lf.publisher;
      if (!d.year) d.year = _lf.year;
      d.source = (d.source || "") + " (דרך חיפוש אינטרנט)";
      if (_age && !(d as any).age) (d as any).age = _age;
      if (_sf.series) { (d as any).series = _sf.series; (d as any).seriesIndex = _sf.seriesIndex; }
      return d;
    }
    return { found: true, source: "חיפוש אינטרנט", title, author: _lf.author, publisher: _lf.publisher, year: _lf.year, language: "עברית", isbn: "", cover: "", age: _age, series: _sf.series, seriesIndex: _sf.seriesIndex };
  }
  return null;
}

// חילוץ סדרה + מספר בסדרה מתוך הכותר: "רוני ותום 2", "יומני החנונית 7 ..." → סדרה=שם, מס=ספרה
function extractSeries(title: string): { series: string; seriesIndex: string } {
  const t = (title || "").trim();
  let m = t.match(/^(.+?)\s+(\d{1,3})\s*(?:[-–:־]|$)/);
  if (!m) m = t.match(/^(.+?)\s+(\d{1,3})\s+\S/);
  if (m && m[1].length >= 2 && +m[2] >= 1 && +m[2] <= 99) return { series: m[1].trim(), seriesIndex: m[2] };
  return { series: "", seriesIndex: "" };
}
// חילוץ טווח גיל מטקסט (תקצירי אתרי חנויות): "גילאי 8-10", "לגילאי 6+", "מגיל 9"
function extractAge(text: string): string {
  const t = text || "";
  let m = t.match(/גיל(?:אי|אים)?\s*:?\s*(\d{1,2})\s*[-–]\s*(\d{1,2})/);
  if (m) return m[1] + "-" + m[2];
  m = t.match(/(?:מגיל|לגיל|גיל)\s*:?\s*(\d{1,2})\s*\+?/);
  if (m) return m[1] + "+";
  return "";
}
// חילוץ שדות מתויגים מכותרת/תקציר של תוצאת חיפוש (אתרי חנויות):
// "מק"ט: 38-1473 מחבר: וולט דיסני מתרגם: יונתן פיין הוצאה לאור: ידיעות אחרונות שנת הדפסה: 2012"
// משמש כ-fallback כשההעשרה מהספרייה הלאומית/Google Books נכשלה — עדיף שדות מהתקציר מאשר כרטיס ריק.
const _LBL = 'מחבר(?:ים|ת)?|סופר(?:ת)?|מאייר(?:ת)?|מתרגם(?:ת)?|עורך|עורכת|הוצאה לאור|הוצאה|מוציא לאור|שנת הדפסה|שנת הוצאה|שנת פרסום|מק"?ט|דאנא?קוד|עמודים|כריכה|שפה|גיל(?:אי|אים)?|סדרה|מהדורה|מחיר|משקל|קטגוריה|ISBN|מסת"?ב';
function fieldAfterLabel(text: string, label: string): string {
  // הערך נגמר לפני התווית הבאה (עם נקודתיים), מפריד (· | •), קיצוץ של גוגל (...) או סוף הטקסט
  const re = new RegExp('(?:^|[\\s·|•,])(?:' + label + ')\\s*:\\s*(.+?)(?=\\s*(?:' + _LBL + ')\\s*:|\\s*[·|•]|\\s*(?:\\.\\.\\.|…)|$)');
  const m = re.exec(text);
  return m ? m[1].replace(/[\s.,;:]+$/, "").trim() : "";
}
// אימות מסת"ב אמיתי (כולל ספרת ביקורת) — מספרי מערכת של הספרייה הלאומית ודאנאקודים לא ייחשבו מסת"ב,
// כדי שלא ייבנו מהם כתובות כריכה שגויות ב-OpenLibrary ולא יישמרו בשדה ISBN בכרטיס
function isValidIsbn(s: string): boolean {
  const d = (s || "").replace(/[^0-9Xx]/g, "");
  if (d.length === 10) {
    if (!/^\d{9}[\dXx]$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += (10 - i) * (+d[i]);
    const c = d[9].toUpperCase() === "X" ? 10 : +d[9];
    return (sum + c) % 11 === 0;
  }
  if (d.length === 13) {
    if (!/^97[89]\d{10}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (+d[i]) * (i % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === +d[12];
  }
  return false;
}
// סדרה מתקציר התוצאה — תופס גם ספר ראשון בסדרה שאין מספר בכותרתו:
// "סדרה: בלשי הביוב", "בסדרת בלשי הביוב", "הספר הראשון בסדרת..." → מס' 1 (רק כשכתוב מפורשות)
function seriesFromSnippet(text: string, bookTitle: string): { series: string; seriesIndex: string } {
  const t = (text || "").replace(/\s+/g, " ");
  let name = fieldAfterLabel(t, 'סדרה');
  if (!name) { const m = t.match(/(?:^|[\s,.·|•(])[במ]סדרת\s+([^·|•,.;:)]{2,40})/); if (m) name = m[1].trim(); }
  if (name) name = name.replace(/["״]/g, "").replace(/[\s.,]+$/, "").trim();
  if (name && (name.length < 2 || name.length > 40)) name = "";
  const first = /(?:הספר\s+|ספר\s+)?ה?ראשו(?:ן|נה)\s+בסדר(?:ה|ת)/.test(t);
  if (!name && first && bookTitle && !/\d/.test(bookTitle)) name = bookTitle;   // "הראשון בסדרה" בלי שם סדרה — הסדרה נקראת כשם הספר
  return { series: name || "", seriesIndex: (name && first) ? "1" : "" };
}
function extractLabeledFields(text: string): { author: string; publisher: string; year: string } {
  const t = (text || "").replace(/\s+/g, " ");
  let author = fieldAfterLabel(t, 'מחבר(?:ים|ת)?|סופר(?:ת)?');
  // "מאת שם הסופר" — הצורה הנפוצה בחנויות; נעצר לפני תווית/מפריד/סוף
  if (!author) { const m = t.match(/(?:^|[\s·|,.(])מאת:?\s+([֐-׿][֐-׿'"׳״.\s]{1,28}?)(?=\s*(?:[·|•,;:)(]|בהוצאת|הוצאה|שנת|עמודים|כריכה|$))/); if (m) author = m[1].replace(/[\s.]+$/, "").trim(); }
  let publisher = fieldAfterLabel(t, 'הוצאה לאור|הוצאה|מוציא לאור');
  if (!publisher) { const m = t.match(/בהוצאת\s+([^·|•,.:]{2,40})/); if (m) publisher = m[1].trim(); }
  const yRaw = fieldAfterLabel(t, 'שנת הדפסה|שנת הוצאה|שנת פרסום');
  const ym = (yRaw || "").match(/(?:19|20)\d{2}/);
  // סינון ערכים חשודים: קצרים/ארוכים מדי או עתירי ספרות (קיצוץ/זבל של גוגל)
  const ok = (v: string) => (v && v.length >= 2 && v.length <= 40 && !/\d{5,}/.test(v)) ? v : "";
  return { author: ok(cleanNliAuthor(author)), publisher: ok(publisher), year: ym ? ym[0] : "" };
}

// חיפוש תמונת כריכה לפי שם הספר (Serper Images) — fallback לספרים שנמצאו בלי כריכה,
// בעיקר ספרי דאנאקוד שאין להם מסת"ב מאומת ולכן אין להם מקור כריכה במאגרים.
// סינון: רק https, מידות סבירות, פרופורציית כריכה (גובה ≥ רוחב); עדיפות לתוצאה עם כיתוב דומה לשם.
async function findCoverImage(title: string): Promise<string> {
  const SERPER = Deno.env.get("SERPER_API_KEY") || "";
  if (!SERPER || !title) return "";
  // ניקוי לשיפור האיתור: מקפים דבוקים ("אלופה-בית") הופכים לרווחים; בלי ציטוט מדויק.
  const clean = title.replace(/[-–־]/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  const queries = [clean + " ספר כריכה"];
  if (words.length > 4) queries.push(words.slice(0, 4).join(" ") + " ספר כריכה");   // שם ארוך — ניסיון שני עם תחילתו
  for (const q of queries) {
    const r = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": SERPER, "Content-Type": "application/json" },
      body: JSON.stringify({ q, gl: "il", hl: "iw", num: 8 }),
    });
    if (!r.ok) { tri(`ImageSearch → http ${r.status}`); return ""; }
    const data = await r.json();
    const all = (data.images || []);
    const imgs = all.filter((im: any) => {
      const u = im.imageUrl || ""; const w = +im.imageWidth || 0, h = +im.imageHeight || 0;
      const dom = ((im.domain || im.link || "") + "").toLowerCase();
      if (/pinterest|aliexpress|ebay\.|etsy\.|yad2|facebook|instagram|tiktok|walla\.|ynet\.|mako\.|wikipedia/.test(dom)) return false;   // מקורות תמונה לא-אמינים לכריכות
      return /^https:/.test(u) && h >= 150 && w >= 100 && h >= w * 1.02;
    });
    // רק תמונה שהכיתוב שלה דומה לשם הספר — עדיף בלי כריכה מאשר כריכה של ספר אחר.
    // וכלל מספרים: "רוני ותום 2" לא יקבל כריכה שכיתובה "רוני ותום 5" (כרך שגוי מאותה סדרה)
    const tNums = (clean.match(/\d+/g) || []);
    const best = imgs.find((im: any) => {
      const cap = im.title || "";
      if (!titleSimilar(clean, cap)) return false;
      const cNums = (cap.match(/\d+/g) || []);
      if (tNums.length && cNums.length && !tNums.some((n: string) => cNums.includes(n))) return false;
      return true;
    });
    tri(`ImageSearch "${q.slice(0, 30)}" → ${all.length} תוצאות, ${imgs.length} בצורת כריכה, ${best ? "כיתוב דומה ✓" : "אין התאמה"}`);
    if (best) return best.imageUrl;
  }
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const NLI = Deno.env.get("NLI_API_KEY") || "";

    // נדרש משתמש מחובר (כל תפקיד) — האתר נעול בהתחברות
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) return json({ error: "missing authorization" }, 401);
    const asUser = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await asUser.auth.getUser();
    if (error || !user) return json({ error: "invalid session" }, 401);

    const body = await req.json().catch(() => ({}));

    // מצב בדיקה עצמית: הפונקציה בודקת את הסודות שהיא מחזיקה ומחזירה את תשובות המקורות
    if (body.selftest) {
      const out: any = { selftest: true, fn: "v28", nli_key: !!NLI };
      const CK = Deno.env.get("GOOGLE_CSE_KEY") || "";
      const CX = Deno.env.get("GOOGLE_CSE_ID") || "";
      out.cse_key_present = !!CK; out.cse_key_prefix = CK ? CK.slice(0, 8) + "…" + CK.slice(-4) + " (" + CK.length + " תווים)" : "";
      out.cse_id = CX || "(ריק)";
      if (NLI) {
        try { const r = await fetch(`https://api.nli.org.il/openlibrary/search?api_key=${encodeURIComponent(NLI)}&query=${encodeURIComponent("any,contains,הנסיך הקטן")}&output_format=json`);
          out.nli = "http " + r.status; } catch (e) { out.nli = "כשל רשת"; }
      } else out.nli = "אין מפתח";
      const SP = Deno.env.get("SERPER_API_KEY") || "";
      out.serper_key_present = !!SP; if (SP) out.serper_key_prefix = SP.slice(0, 6) + "…" + SP.slice(-4);
      if (SP) {
        try { const r = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "X-API-KEY": SP, "Content-Type": "application/json" }, body: JSON.stringify({ q: "test", num: 1 }) });
          let t = ""; try { t = (await r.text()).slice(0, 160).replace(/\s+/g, " "); } catch (_) {}
          out.cse = "Serper http " + r.status + (r.ok ? " ✓" : " · " + t); } catch (e) { out.cse = "Serper כשל רשת"; }
      } else if (CK && CX) {
        try { const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(CK)}&cx=${encodeURIComponent(CX)}&q=test`);
          let t = ""; try { t = (await r.text()).slice(0, 220).replace(/\s+/g, " "); } catch (_) {}
          out.cse = "Google http " + r.status + (r.ok ? " ✓" : " · " + t); } catch (e) { out.cse = "Google כשל רשת"; }
      } else out.cse = "אין ספק חיפוש מוגדר";
      return json(out);
    }

    const q = (body.q || "").trim();
    if (!q) return json({ found: false, error: "empty query" }, 400);

    // מצב "כריכה בלבד" (כפתור 🔍 חפש כריכה): חיפוש תמונה ישיר לפי השם, בלי תלות במציאת הספר במאגרים
    if (body.coverOnly) {
      TRIED.length = 0;
      let img = "";
      try { img = await findCoverImage(q); } catch (_) { tri("ImageSearch שגיאה"); }
      return json({ found: !!img, cover: img, fn: "v28", tried: TRIED.slice() });
    }

    TRIED.length = 0;
    let result = null;
    if (NLI) { try { result = await lookupNLI(q, NLI); } catch (_) { /* מתעלמים — נופלים לגוגל */ } }
    if (!result) { try { result = await lookupGoogle(q); } catch (_) { /* מתעלמים */ } }
    const CSE_KEY = Deno.env.get("GOOGLE_CSE_KEY") || "";
    const CSE_ID = Deno.env.get("GOOGLE_CSE_ID") || "";
    const HAS_WEB = !!(Deno.env.get("SERPER_API_KEY") || (CSE_KEY && CSE_ID));
    if (!result && HAS_WEB) { try { result = await lookupWebSearch(q, CSE_KEY, CSE_ID); } catch (e) { tri("WebSearch שגיאה: " + String(e)); } }
    const CSE_ON = !!(Deno.env.get("SERPER_API_KEY") || (Deno.env.get("GOOGLE_CSE_KEY") && Deno.env.get("GOOGLE_CSE_ID")));
    if (!result) return json({ found: false, fn: "v28", nli_key: !!NLI, web_search: CSE_ON, tried: TRIED.slice() });
    (result as any).fn = "v28";
    const se = extractSeries((result as any).title || "");
    if (se.series) { (result as any).series = se.series; (result as any).seriesIndex = se.seriesIndex; }
    // ספר שנמצא בלי כריכה — ניסיון אחרון: חיפוש תמונה לפי השם
    if (!(result as any).cover && (result as any).title) {
      try { const img = await findCoverImage((result as any).title); if (img) (result as any).cover = img; }
      catch (_) { tri("ImageSearch שגיאה"); }
    }
    (result as any).tried = TRIED.slice();   // יומן ניסיונות גם בהצלחה — לאבחון מקור הכריכה/הפרטים
    return json(result);
  } catch (e) {
    return json({ found: false, error: String((e as any)?.message || e) }, 500);
  }
});
