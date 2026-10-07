import type { PackReport } from './model.ts';
import { toPublicReport, type ProjectionOptions } from './serialization.ts';
import { reportClient, reportStyles } from './report-ui.ts';

export interface RenderOptions extends ProjectionOptions { scenarios?:PackReport[]; locale?:'zh-CN'|'en' }
export function safeJson(value:unknown):string {
  return JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
}
/** Every saved scene comes from a complete official analysis. */
export function renderHtml(report:PackReport,options:RenderOptions={}):string {
  if(options.scenarios?.some(r=>!r.complete))throw Error('INCOMPLETE_SAVED_SCENARIO');
  const data={reports:[report,...(options.scenarios??[])].map(r=>toPublicReport(r,options)),locale:options.locale??'zh-CN'};
  return `<!doctype html><html lang="${data.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>PackLens · Package evidence</title><style>${reportStyles}</style></head><body><main id="app"></main><script id="report-data" type="application/json">${safeJson(data)}</script><script>(${reportClient.toString()})();</script></body></html>`;
}
