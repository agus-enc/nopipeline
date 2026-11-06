import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMarkdown,
  contentType,
  hostedFile,
  imageContentType,
  isImageLine,
  isImagePath,
  isUnsearchableMediaLine,
  mediaKind,
  mediaLine,
  MEDIA_TAG,
  placeholderPath,
  placeholderUrl,
  PLACEHOLDER_BASE,
  stripSignatures,
} from "../../src/notion/hosted.ts";

const KEY = "cfdfc7c5-9649-4e3a-8148-8a38d31e611e";
const WORKSPACE = "4f1c2a9e-0000-4000-8000-123456789abc";
const BARE = `https://prod-files-secure.s3.us-west-2.amazonaws.com/${WORKSPACE}/${KEY}/whisk.png`;
const signed = (sig: string) => `${BARE}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261103%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Signature=${sig}#notion_record=block.0a1b2c3d-0000-4000-8000-000000000001.${WORKSPACE}`;

test("a placeholder URL carries the encoded vault path and decodes back", () => {
  const path = "Assets/pictures/old map.png";
  assert.equal(PLACEHOLDER_BASE, "https://nopipeline.invalid/vault/");
  assert.equal(placeholderUrl(path), "https://nopipeline.invalid/vault/Assets/pictures/old%20map.png");
  assert.equal(placeholderPath(placeholderUrl(path)), path);
  assert.equal(placeholderPath("https://nopipeline.invalid/vault/Assets%2Fpictures%2Fold%20map.png"), path);
  const odd = "Notes/a (1) 100%.png";
  assert.equal(placeholderPath(placeholderUrl(odd)), odd);
  assert.equal(placeholderPath("https://example.com/vault/x.png"), null);
  assert.equal(placeholderPath(`${PLACEHOLDER_BASE}%E0%A4%A.png`), null);
});

test("image paths and their content types", () => {
  assert.equal(imageContentType("a/b.PNG"), "image/png");
  assert.equal(imageContentType("a/b.jpg"), "image/jpeg");
  assert.equal(imageContentType("a/b.jpeg"), "image/jpeg");
  assert.equal(imageContentType("b.svg"), "image/svg+xml");
  assert.equal(imageContentType("b.tif"), "image/tiff");
  assert.equal(imageContentType("b.ico"), "image/x-icon");
  assert.equal(imageContentType("b.heic"), "image/heic");
  assert.equal(imageContentType("b.bmp"), "image/bmp");
  assert.equal(imageContentType("b.gif"), "image/gif");
  assert.equal(imageContentType("b.webp"), "image/webp");
  assert.equal(imageContentType("notes.pdf"), null);
  assert.equal(imageContentType("png"), null);
  assert.equal(imageContentType("dir.png/readme"), null);
  assert.equal(isImagePath("x/y.webp"), true);
  assert.equal(isImagePath("x/y.md"), false);
});

test("hostedFile reads the key and name from a signed Notion file URL", () => {
  assert.deepEqual(hostedFile(signed("abc")), { key: KEY, name: "whisk.png", bare: BARE });
  assert.deepEqual(hostedFile(BARE), { key: KEY, name: "whisk.png", bare: BARE });
  const spaced = `https://prod-files-secure.s3.eu-central-1.amazonaws.com/${WORKSPACE}/${KEY}/my%20pic.png?X-Amz-Signature=1`;
  assert.deepEqual(hostedFile(spaced), { key: KEY, name: "my pic.png", bare: spaced.split("?")[0] });
  assert.equal(hostedFile("https://example.com/a/b/c.png"), null);
  assert.equal(hostedFile(`https://nopipeline.invalid/vault/${KEY}/x.png`), null);
  assert.equal(hostedFile(`https://prod-files-secure.s3.us-west-2.amazonaws.com/${WORKSPACE}/not-a-uuid/x.png`), null);
});

test("stripSignatures makes two signed variants of one URL the same text", () => {
  const a = `Before\n\n![cap](${signed("one")})\n\nAfter`;
  const b = `Before\n\n![cap](${signed("two")})\n\nAfter`;
  assert.notEqual(a, b);
  assert.equal(stripSignatures(a), stripSignatures(b));
  assert.equal(stripSignatures(a), `Before\n\n![cap](${BARE})\n\nAfter`);
});

test("stripSignatures reaches file, pdf, video and audio blocks too", () => {
  const text = [
    `<pdf src="${signed("p")}"></pdf>`,
    `<file src="${signed("f")}">report</file>`,
    `<video src="${signed("v")}"></video>`,
    `<audio src="${signed("a")}"></audio>`,
    "[a link](https://example.com/page?x=1#y)",
  ].join("\n");
  assert.equal(
    stripSignatures(text),
    [
      `<pdf src="${BARE}"></pdf>`,
      `<file src="${BARE}">report</file>`,
      `<video src="${BARE}"></video>`,
      `<audio src="${BARE}"></audio>`,
      "[a link](https://example.com/page?x=1#y)",
    ].join("\n"),
  );
});

test("canonicalMarkdown writes known images as placeholders and leaves unknown ones bare", () => {
  const other = "11111111-2222-4333-8444-555555555555";
  const otherBare = `https://prod-files-secure.s3.us-west-2.amazonaws.com/${WORKSPACE}/${other}/x.png`;
  const md = `![cap](${signed("s")})\n- \n\t![](${otherBare}?X-Amz-Signature=2)\n<pdf src="${otherBare.replace("x.png", "y.pdf")}?X-Amz-Signature=3"></pdf>`;
  const pathOf = (key: string) => (key === KEY ? "Assets/whisk.png" : null);
  assert.equal(
    canonicalMarkdown(md, pathOf),
    `![cap](https://nopipeline.invalid/vault/Assets/whisk.png)\n- \n\t![](${otherBare})\n<pdf src="${otherBare.replace("x.png", "y.pdf")}"></pdf>`,
  );
});

test("isImageLine accepts an image alone on its line at any tab depth", () => {
  assert.equal(isImageLine("\t![c](x)"), true);
  assert.equal(isImageLine("![](x)"), true);
  assert.equal(isImageLine("\t\t![a \\] b](https://example.com/p.png)"), true);
  assert.equal(isImageLine("Text ![c](x) text"), false);
  assert.equal(isImageLine("> ![c](x)"), false);
  assert.equal(isImageLine("- ![c](x)"), false);
});

test("a file name with parentheses (a browser's `probe (1).png`) parses, as the URL and inside an image line", () => {
  const bare = `https://prod-files-secure.s3.us-west-2.amazonaws.com/${WORKSPACE}/${KEY}/probe%20(1).png`;
  const url = `${bare}?X-Amz-Signature=abc#notion_record=block.0a1b2c3d-0000-4000-8000-000000000001.${WORKSPACE}`;
  assert.deepEqual(hostedFile(url), { key: KEY, name: "probe (1).png", bare });
  assert.deepEqual(hostedFile(bare), { key: KEY, name: "probe (1).png", bare });
  const line = `\t![a (b)](${url})`;
  assert.equal(isImageLine(line), true);
  assert.equal(stripSignatures(line), `\t![a (b)](${bare})`);
  assert.equal(canonicalMarkdown(line, (key) => (key === KEY ? "pics/probe (1).png" : null)), `\t![a (b)](${placeholderUrl("pics/probe (1).png")})`);
  // the parenthesis that closes the link is not part of the name
  assert.equal(stripSignatures(`[x](${bare}?X-Amz-Signature=1)`), `[x](${bare})`);
  assert.equal(hostedFile(`${bare.replace("(1)", "(1")}`), null);
});

test("isUnsearchableMediaLine: hosted and placeholder image lines, at any depth; a web image, text and other lines no (final review 9)", () => {
  const hosted = "https://prod-files-secure.s3.us-west-2.amazonaws.com/4f1c2a9e-0000-4000-8000-123456789abc/4b9c2e58-1111-4222-8333-444455556666/a.png";
  assert.equal(isUnsearchableMediaLine(`![c](${hosted})`), true);
  assert.equal(isUnsearchableMediaLine(`\t![](${hosted}?X-Amz-Signature=1#notion_record=block.abc.def)`), true);
  assert.equal(isUnsearchableMediaLine(`![c](${placeholderUrl("Assets/a b.png")})`), true);
  assert.equal(isUnsearchableMediaLine("![c](https://example.com/a.png)"), false);
  assert.equal(isUnsearchableMediaLine("![c]()"), false);
  assert.equal(isUnsearchableMediaLine(`see ![c](${hosted})`), false);
  assert.equal(isUnsearchableMediaLine("plain text"), false);
});

test("mediaKind by extension, any case; notes, canvases, bases and extensionless names are none", () => {
  assert.equal(mediaKind("a.PDF"), "pdf");
  assert.equal(mediaKind("dir/x.mp3"), "audio");
  for (const ext of ["flac", "m4a", "ogg", "wav", "3gp"]) assert.equal(mediaKind(`x.${ext}`), "audio");
  assert.equal(mediaKind("x.webm"), "video");
  for (const ext of ["mkv", "mov", "mp4", "ogv"]) assert.equal(mediaKind(`x.${ext}`), "video");
  assert.equal(mediaKind("x.docx"), "file");
  assert.equal(mediaKind("x.weird"), "file");
  assert.equal(mediaKind("x.png"), "image");
  assert.equal(mediaKind("x.JPG"), "image");
  assert.equal(mediaKind("n.md"), null);
  assert.equal(mediaKind("n.MD"), null);
  assert.equal(mediaKind("c.canvas"), null);
  assert.equal(mediaKind("b.base"), null);
  assert.equal(mediaKind("noext"), null);
  assert.equal(mediaKind("dir.png/readme"), null);
});

test("a legacy JSON drawing (.excalidraw) is a drawing, never an attachment, in any case", () => {
  assert.equal(mediaKind("Drawing 2023.excalidraw"), null);
  assert.equal(mediaKind("dir/Sketch.EXCALIDRAW"), null);
  // Only the whole extension: `.excalidraw.png` (a drawing exported as an image) is an image.
  assert.equal(mediaKind("Drawing.excalidraw.png"), "image");
});

test("contentType: the common type of the extension, else octet-stream", () => {
  assert.equal(contentType("x.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(contentType("x.weird"), "application/octet-stream");
  assert.equal(contentType("noext"), "application/octet-stream");
  assert.equal(contentType("a/b.PNG"), "image/png");
  assert.equal(contentType("g.pdf"), "application/pdf");
  assert.equal(contentType("s.mp3"), "audio/mpeg");
  assert.equal(contentType("s.m4a"), "audio/mp4");
  assert.equal(contentType("s.ogg"), "audio/ogg");
  assert.equal(contentType("s.wav"), "audio/wav");
  assert.equal(contentType("s.flac"), "audio/flac");
  assert.equal(contentType("s.3gp"), "audio/3gpp");
  assert.equal(contentType("v.mp4"), "video/mp4");
  assert.equal(contentType("v.webm"), "video/webm");
  assert.equal(contentType("v.mov"), "video/quicktime");
  assert.equal(contentType("v.mkv"), "video/x-matroska");
  assert.equal(contentType("v.ogv"), "video/ogg");
  assert.equal(contentType("t.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(contentType("t.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(contentType("t.zip"), "application/zip");
  assert.equal(contentType("t.txt"), "text/plain");
  assert.equal(contentType("t.csv"), "text/csv");
  assert.equal(contentType("t.json"), "application/json");
});

const MANUAL = `https://prod-files-secure.s3.us-west-2.amazonaws.com/${WORKSPACE}/${KEY}/Manual.pdf`;
const MANUAL_SIGNED = `${MANUAL}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc#notion_record=block.0a1b2c3d-0000-4000-8000-000000000001.${WORKSPACE}`;

test("mediaLine reads an image line and a pdf, file, audio or video tag line; nothing else", () => {
  assert.deepEqual(mediaLine(`<pdf src="${MANUAL_SIGNED}">cap</pdf>`), { indent: "", kind: "pdf", caption: "cap", url: MANUAL_SIGNED });
  assert.deepEqual(mediaLine(`\t\t<file src="${MANUAL}"></file>`), { indent: "\t\t", kind: "file", caption: "", url: MANUAL });
  assert.deepEqual(mediaLine('<audio src="https://example.com/a.mp3">a \\< b</audio>'), { indent: "", kind: "audio", caption: "a \\< b", url: "https://example.com/a.mp3" });
  assert.deepEqual(mediaLine('\t<video src="https://youtu.be/x"></video>'), { indent: "\t", kind: "video", caption: "", url: "https://youtu.be/x" });
  assert.deepEqual(mediaLine("\t![cap](https://example.com/a.png)"), { indent: "\t", kind: "image", caption: "cap", url: "https://example.com/a.png" });
  assert.equal(mediaLine(`see <pdf src="${MANUAL}"></pdf>`), null);
  assert.equal(mediaLine(`<pdf src="${MANUAL}"></file>`), null);
  assert.equal(mediaLine(`<image src="${MANUAL}"></image>`), null);
  assert.equal(mediaLine(`<pdf src="${MANUAL}">a <b> c</pdf>`), null);
  assert.equal(mediaLine("plain text"), null);
  assert.ok(MEDIA_TAG.test(`<pdf src="${MANUAL}">x</pdf>`));
});

test("canonicalMarkdown: a known key's media tag becomes the placeholder of its path; two signed reads agree; an unknown key stays bare", () => {
  const pathOf = (key: string) => (key === KEY ? "Assets/attachments/Manual.pdf" : null);
  assert.equal(
    canonicalMarkdown(`<pdf src="${MANUAL_SIGNED}">cap</pdf>`, pathOf),
    '<pdf src="https://nopipeline.invalid/vault/Assets/attachments/Manual.pdf">cap</pdf>',
  );
  const a = `- \n\t<file src="${MANUAL}?X-Amz-Signature=one#notion_record=block.x.${WORKSPACE}">r</file>`;
  const b = `- \n\t<file src="${MANUAL}?X-Amz-Signature=two#notion_record=block.x.${WORKSPACE}">r</file>`;
  assert.equal(canonicalMarkdown(a, pathOf), canonicalMarkdown(b, pathOf));
  assert.equal(canonicalMarkdown(a, pathOf), '- \n\t<file src="https://nopipeline.invalid/vault/Assets/attachments/Manual.pdf">r</file>');
  assert.equal(canonicalMarkdown(`<video src="${MANUAL_SIGNED}">c</video>`, () => null), `<video src="${MANUAL}">c</video>`);
  assert.equal(canonicalMarkdown('<video src="https://youtu.be/x"></video>', pathOf), '<video src="https://youtu.be/x"></video>');
  assert.equal(
    canonicalMarkdown(`<audio src="${MANUAL}">a b</audio>`, () => "n/a (1) b.mp3"),
    `<audio src="${placeholderUrl("n/a (1) b.mp3")}">a b</audio>`,
  );
});

test("stripSignatures reads a tag line's signed src too", () => {
  assert.equal(stripSignatures(`\t<pdf src="${MANUAL_SIGNED}">cap</pdf>`), `\t<pdf src="${MANUAL}">cap</pdf>`);
});

test("isUnsearchableMediaLine: a hosted or placeholder line of any kind; a web URL no", () => {
  assert.equal(isUnsearchableMediaLine(`<video src="${MANUAL_SIGNED}"></video>`), true);
  assert.equal(isUnsearchableMediaLine(`\t<pdf src="${MANUAL}">c</pdf>`), true);
  assert.equal(isUnsearchableMediaLine(`<file src="${placeholderUrl("Assets/a b.docx")}">c</file>`), true);
  assert.equal(isUnsearchableMediaLine(`<audio src="${placeholderUrl("x.mp3")}"></audio>`), true);
  assert.equal(isUnsearchableMediaLine('<video src="https://youtu.be/x"></video>'), false);
  assert.equal(isUnsearchableMediaLine(`see <pdf src="${MANUAL}"></pdf>`), false);
  assert.equal(isUnsearchableMediaLine(`![c](${placeholderUrl("a.png")})`), true);
});
