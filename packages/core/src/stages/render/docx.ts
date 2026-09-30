/** RDoc -> DOCX (A4, 맑은 고딕, heading styles, bordered tables, page numbers). */
import {
  AlignmentType,
  BorderStyle,
  Bookmark,
  Document,
  Footer,
  HeadingLevel,
  InternalHyperlink,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { normalizeZip } from "./zip-normalize";
import type { RBlock, RDoc, RRun } from "./types";

const FONT = { ascii: "Malgun Gothic", hAnsi: "Malgun Gothic", eastAsia: "맑은 고딕", cs: "Malgun Gothic" };
const LINE = { style: BorderStyle.SINGLE, size: 4, color: "808080" };
const CELL_BORDERS = { top: LINE, bottom: LINE, left: LINE, right: LINE };

function runsOf(runs: readonly RRun[], extra: { bold?: boolean; size?: number } = {}): TextRun[] {
  return runs.map((r) => {
    const base = { text: r.text, font: FONT, bold: extra.bold, size: extra.size };
    if (r.kind === "unresolved") return new TextRun({ ...base, bold: true, color: "9C0006", shading: { type: ShadingType.CLEAR, fill: "FFC7CE" } });
    if (r.kind === "cite") return new TextRun({ ...base, italics: true });
    if (r.kind === "link") return new TextRun({ ...base, color: "0B4F9C", underline: {} });
    return new TextRun(base);
  });
}

const text = (t: string, opts: { bold?: boolean; size?: number; color?: string } = {}) => new TextRun({ text: t, font: FONT, ...opts });

function tableDocx(caption: string, header: readonly string[], rows: readonly (readonly RRun[])[][]): (Paragraph | Table)[] {
  const cell = (children: TextRun[], head: boolean) =>
    new TableCell({
      borders: CELL_BORDERS,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: head ? { type: ShadingType.CLEAR, fill: "E8ECF2" } : undefined,
      children: [new Paragraph({ children })],
    });
  const cols = Math.max(1, header.length);
  return [
    new Paragraph({ spacing: { before: 200, after: 80 }, keepNext: true, children: [text(caption, { bold: true })] }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: Array.from({ length: cols }, () => Math.floor(9000 / cols)),
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h) => cell([text(h, { bold: true })], true)) }),
        ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c) => cell(runsOf(c), false)) })),
      ],
    }),
    new Paragraph({ children: [] }),
  ];
}

export async function docToDocx(doc: RDoc): Promise<Uint8Array> {
  const orderedRefs: string[] = [];
  const blockDocx = (b: RBlock): (Paragraph | Table)[] => {
    switch (b.t) {
      case "para":
        return [new Paragraph({ spacing: { after: 120 }, children: runsOf(b.runs) })];
      case "list": {
        if (!b.ordered) return b.items.map((it) => new Paragraph({ bullet: { level: 0 }, children: runsOf(it) }));
        const ref = `ol-${orderedRefs.length}`;
        orderedRefs.push(ref);
        return b.items.map((it) => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runsOf(it) }));
      }
      case "table":
        return tableDocx(b.caption, b.header, b.rows);
      case "note":
        return [
          new Paragraph({
            spacing: { before: 100, after: 120 },
            indent: { left: 200 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: b.kind === "manual_review" ? "B58900" : "808080", space: 8 } },
            children: [text(`${b.label} `, { bold: true }), ...runsOf(b.runs)],
          }),
        ];
    }
  };

  const children: (Paragraph | Table)[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [text(doc.title, { bold: true })] })];
  for (const s of doc.subtitle) children.push(new Paragraph({ children: [text(s)] }));
  if (doc.banner) {
    children.push(
      new Paragraph({
        spacing: { before: 120, after: 120 },
        shading: { type: ShadingType.CLEAR, fill: "FFF3CD" },
        border: { top: LINE, bottom: LINE, left: LINE, right: LINE },
        children: [text(doc.banner, { bold: true })],
      }),
    );
  }
  if (doc.sections.length > 0) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [text("목차")] }));
    for (const s of doc.sections) {
      children.push(new Paragraph({ children: [new InternalHyperlink({ anchor: s.anchor, children: [text(s.heading, { color: "0B4F9C" })] })] }));
    }
  }
  for (const s of doc.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new Bookmark({ id: s.anchor, children: [text(s.heading)] })] }));
    for (const b of s.blocks) children.push(...blockDocx(b));
  }
  if (doc.changeHistory) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [text(doc.changeHistory.caption)] }));
    children.push(...tableDocx(doc.changeHistory.caption, doc.changeHistory.header, doc.changeHistory.rows.map((r) => r.map((c): RRun[] => [{ kind: "text", text: c }]))));
  }
  children.push(new Paragraph({ border: { top: LINE }, spacing: { before: 300 }, children: [] }));
  if (doc.disclaimer) children.push(new Paragraph({ children: [text(doc.disclaimer, { size: 18 })] }));
  if (doc.attribution) children.push(new Paragraph({ children: [text(doc.attribution, { size: 18 })] }));
  for (const st of doc.stamps) children.push(new Paragraph({ children: [text(st, { size: 16 })] }));

  const d = new Document({
    creator: "privacy-agent",
    title: doc.title,
    description: "Reference draft (not legal advice)",
    styles: {
      default: {
        document: { run: { font: FONT, size: 21 }, paragraph: { spacing: { line: 320 } } },
        title: { run: { font: FONT, size: 36, bold: true }, paragraph: { spacing: { after: 160 } } },
        heading2: { run: { font: FONT, size: 26, bold: true }, paragraph: { spacing: { before: 320, after: 120 }, keepNext: true } },
      },
    },
    numbering: {
      config: orderedRefs.map((reference) => ({
        reference,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 540, hanging: 300 } } } }],
      })),
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], font: FONT, size: 18 })] })],
          }),
        },
        children,
      },
    ],
  });
  const raw = new Uint8Array(await Packer.toBuffer(d));
  return normalizeZip(raw);
}
