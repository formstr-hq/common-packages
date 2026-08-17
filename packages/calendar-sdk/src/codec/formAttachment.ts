import type { FormAttachment } from "../types";

/**
 * Formstr form attachment rows — docs/protocol.md §10.
 *
 *   ["form", <naddr>, <formViewKey>?]
 *
 * The optional third element is the form's **read-only** NIP-44 decryption key,
 * the value Formstr surfaces as `?viewKey=<hex>`.
 *
 * It must NEVER be the form's `responseKey` (admin/edit key): that grants write
 * access to the form definition, so embedding it would let every recipient of
 * the calendar event rewrite the form. Upstream states this twice, in
 * `events.ts:126` and `utils/types.ts:37`, because the mistake is invisible
 * until it is exploited.
 */

export function formAttachmentToTag(form: FormAttachment): string[] | null {
  if (!form?.naddr) return null;
  return form.viewKey ? ["form", form.naddr, form.viewKey] : ["form", form.naddr];
}

export function formAttachmentsToTags(forms: readonly FormAttachment[] | undefined): string[][] {
  const tags: string[][] = [];
  for (const form of forms ?? []) {
    const tag = formAttachmentToTag(form);
    if (tag) tags.push(tag);
  }
  return tags;
}

/**
 * Reads every `form` row. The view key is the **same row's** third element —
 * upstream reads `event.tags[index]?.[2]` while iterating, so a parser that
 * looks at the next row instead silently loses every key.
 */
export function parseFormAttachments(tags: readonly (readonly string[])[]): FormAttachment[] {
  const forms: FormAttachment[] = [];
  for (const tag of tags) {
    if (tag[0] !== "form" || !tag[1]) continue;
    forms.push(tag[2] ? { naddr: tag[1], viewKey: tag[2] } : { naddr: tag[1] });
  }
  return forms;
}
