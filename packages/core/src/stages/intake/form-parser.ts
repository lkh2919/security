/**
 * Service-description form parser: JSON or simple Markdown `key: value` -> FormSlots.
 * `parseFormRaw` returns unmasked structure; `maskForm` masks every string with the run's masker.
 */
import { SLOT_ID_PATTERN } from "../../contracts/common";
import { FormSlotsSchema, type FormSlots } from "../../contracts/form-slots";
import type { PiiMasker } from "./masker";
import { sanitizeText } from "./sanitize";

type FormValue = string | number | boolean | string[];

export interface RawFlow {
  name: string;
  dataItems: string[];
  purposes: string[];
  recipients: string[];
  retention?: string;
}
export interface RawForm {
  formVersion: string;
  serviceName: string;
  description: string;
  slots: Record<string, FormValue>;
  fields: Record<string, FormValue>;
  flows: RawFlow[];
}

export class FormParseError extends Error {}

export const BUILTIN_FORM_VERSION = "builtin-1";

const KEY_ALIASES: Record<string, "serviceName" | "description" | "formVersion"> = {
  servicename: "serviceName", service_name: "serviceName", 서비스명: "serviceName", 서비스이름: "serviceName", 서비스: "serviceName",
  description: "description", 설명: "description", 서비스설명: "description", 서비스개요: "description", 개요: "description",
  formversion: "formVersion", form_version: "formVersion", 양식버전: "formVersion", 폼버전: "formVersion",
};
const FLOW_KEYS: Record<string, keyof Omit<RawFlow, "name">> = {
  항목: "dataItems", 수집항목: "dataItems", 데이터: "dataItems", dataitems: "dataItems",
  목적: "purposes", 이용목적: "purposes", purposes: "purposes",
  수신자: "recipients", 제공대상: "recipients", 제공받는자: "recipients", recipients: "recipients",
  보유기간: "retention", 보유: "retention", retention: "retention",
};
const FLOW_HEADING = /^#{1,6}\s*(?:데이터\s*흐름|흐름|flow)\s*[:：]?\s*(.*)$/i;
/** Form fields that hold a person's name: registered with the masker so every occurrence is masked. */
const OWNER_KEY = /(담당자|성명|성함|책임자|보호책임|owner|contact|manager|author|reporter)/i;

const norm = (k: string): string => k.trim().toLowerCase().replace(/[\s-]+/g, "");
const toList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,、;]|\s\/\s/)).map((s) => sanitizeText(s).trim()).filter(Boolean);

function scalar(v: string): string | boolean {
  const t = v.trim();
  return /^true$/i.test(t) ? true : /^false$/i.test(t) ? false : t;
}

export function parseFormRaw(content: string): RawForm {
  const body = content.replace(/^﻿/, "").trim();
  return body.startsWith("{") ? fromJson(body) : fromMarkdown(body);
}

function emptyForm(): RawForm {
  return { formVersion: BUILTIN_FORM_VERSION, serviceName: "", description: "", slots: {}, fields: {}, flows: [] };
}

function assign(form: RawForm, key: string, value: unknown): void {
  const alias = KEY_ALIASES[norm(key)];
  if (alias) {
    (form as unknown as Record<string, string>)[alias] = sanitizeText(String(value)).trim();
    return;
  }
  const v: FormValue = Array.isArray(value) ? value.map(String) : typeof value === "object" && value !== null ? JSON.stringify(value) : (value as string | number | boolean);
  if (SLOT_ID_PATTERN.test(key.trim())) form.slots[key.trim()] = typeof v === "string" ? scalar(v) : v;
  else form.fields[key.trim()] = v;
}

function fromJson(text: string): RawForm {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FormParseError("form is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new FormParseError("form JSON must be an object");
  const form = emptyForm();
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (k === "flows" && Array.isArray(v)) {
      form.flows = v.map((f, i) => flowFromObject(f as Record<string, unknown>, i));
    } else if (k === "slots" && v && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) assign(form, sk, sv);
    } else if (k === "fields" && v && typeof v === "object") {
      for (const [fk, fv] of Object.entries(v)) {
        if (KEY_ALIASES[norm(fk)]) assign(form, fk, fv);
        else form.fields[fk] = Array.isArray(fv) ? fv.map(String) : typeof fv === "object" && fv !== null ? JSON.stringify(fv) : (fv as string | number | boolean);
      }
    } else assign(form, k, v);
  }
  return finish(form);
}

function flowFromObject(f: Record<string, unknown>, i: number): RawFlow {
  const flow: RawFlow = { name: sanitizeText(String(f.name ?? `flow-${i + 1}`)).trim(), dataItems: [], purposes: [], recipients: [] };
  for (const [k, v] of Object.entries(f)) {
    const target = FLOW_KEYS[norm(k)];
    if (target === "retention") flow.retention = sanitizeText(String(v)).trim();
    else if (target) flow[target] = toList(v);
  }
  return flow;
}

function fromMarkdown(text: string): RawForm {
  const form = emptyForm();
  let flow: RawFlow | null = null;
  let h1: string | undefined;
  let lastAssign: (() => void) | null = null;
  let lastText = "";
  for (const line0 of text.split(/\r\n|\r|\n/)) {
    const line = line0.trim();
    if (!line) continue;
    const fh = line.match(FLOW_HEADING);
    if (fh) {
      flow = { name: sanitizeText(fh[1]).trim() || `flow-${form.flows.length + 1}`, dataItems: [], purposes: [], recipients: [] };
      form.flows.push(flow);
      lastAssign = null;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (heading[1] === "#" && !h1) h1 = heading[2].trim();
      else flow = null;
      lastAssign = null;
      continue;
    }
    const kv = line.replace(/^[-*]\s+/, "").match(/^([^:：]{1,60}?)\s*[:：]\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      lastText = value;
      const target = flow ? FLOW_KEYS[norm(key)] : undefined;
      if (flow && target) {
        const f = flow;
        const set = (): void => {
          if (target === "retention") f.retention = sanitizeText(lastText).trim();
          else f[target] = toList(lastText);
        };
        set();
        lastAssign = set;
      } else {
        const k = key;
        const set = (): void => assign(form, k, lastText);
        set();
        lastAssign = set;
      }
    } else if (lastAssign) {
      lastText += `\n${line}`; // continuation line of a multi-line value
      lastAssign();
    }
  }
  if (!form.serviceName && h1) form.serviceName = sanitizeText(h1);
  return finish(form);
}

function finish(form: RawForm): RawForm {
  if (!form.serviceName) throw new FormParseError("form is missing a service name (serviceName / 서비스명)");
  form.flows = form.flows.filter((f) => f.name);
  return form;
}

/** Masks every string of a parsed form and validates the result as FormSlots. */
export function maskForm(raw: RawForm, masker: PiiMasker, runId: string): FormSlots {
  const mv = (v: FormValue): FormValue => (typeof v === "string" ? masker.mask(v) : Array.isArray(v) ? v.map((s) => masker.mask(s)) : v);
  const mapValues = (r: Record<string, FormValue>, maskKeys: boolean): Record<string, FormValue> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [maskKeys ? masker.mask(k) : k, mv(v)]));
  const nonEmpty = (a: string[]): string[] => a.map((s) => masker.mask(s)).filter(Boolean);
  return FormSlotsSchema.parse({
    runId,
    formVersion: masker.mask(raw.formVersion),
    serviceName: masker.mask(raw.serviceName),
    description: masker.mask(raw.description),
    slots: mapValues(raw.slots, false),
    fields: mapValues(raw.fields, true),
    flows: raw.flows.map((f) => ({
      name: masker.mask(f.name),
      dataItems: nonEmpty(f.dataItems),
      purposes: nonEmpty(f.purposes),
      recipients: nonEmpty(f.recipients),
      ...(f.retention ? { retention: masker.mask(f.retention) } : {}),
    })),
  });
}

/** Registers person names found in owner/contact style form fields with the masker. */
export function registerFormNames(raw: RawForm, masker: PiiMasker): void {
  for (const [k, v] of Object.entries(raw.fields)) {
    if (!OWNER_KEY.test(k)) continue;
    for (const s of Array.isArray(v) ? v : [String(v)]) masker.registerNameIfPlausible(s.trim());
  }
}
