import { z } from "zod";

import { ok, fail } from "../result";
import { requireConfirm } from "../safety";
import { mail } from "../services";
import { DEFAULT_MAIL_DOMAIN } from "@formstr/mailstr-sdk";

import type { ToolDef } from "./types";

/**
 * Mailstr email tools (kind-1301 gift-wrapped mail over the active identity).
 *
 * Reads are always on; the outward/identity-changing actions (`send_mail`,
 * `claim_mailbox`, `publish_mail_setup`) are gated behind `--allow-writes` and
 * `confirm: true`, matching every other write tool. A host can never hold a
 * Lightning wallet, so `claim_mailbox` stops at the bolt11 invoice — the human
 * pays it, and mail starts working once NIP-05 propagates.
 */
export const mailTools: ToolDef[] = buildMailTools();

function buildMailTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  let write = false;
  const server = {
    registerTool(
      name: string,
      config: Pick<ToolDef, "description" | "inputSchema">,
      handler: ToolDef["handler"],
    ) {
      tools.push({ name, ...config, handler, ...(write ? { write: true } : {}) });
    },
  };

  // ── Read ──────────────────────────────────────────────
  server.registerTool(
    "list_mail",
    {
      description:
        "List a page of the mailstr inbox (kind-1059 gift-wrapped email), newest first. " +
        "Returns each message's id, sender, subject and date. Pages are bounded (default 50); " +
        "when the page is full the result carries `oldestReceivedAt` — pass it back as `until` " +
        "to page further back. `since`/`until` are unix seconds; omitted `until` means newest.",
      inputSchema: {
        limit: z.number().optional(),
        since: z.number().optional(),
        until: z.number().optional(),
      },
    },
    async ({ limit, since, until }: { limit?: number; since?: number; until?: number }) => {
      const { mail: messages, failures, oldestReceivedAt, hasMore } = await mail.readMail({
        ...(limit !== undefined ? { limit } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      });
      const rows = messages.map((m) => ({
        id: m.wrapId,
        from: m.from,
        subject: m.subject,
        date: new Date(m.receivedAt * 1000).toISOString(),
      }));
      let text = `${messages.length} message(s) in this page of your inbox.`;
      if (hasMore && oldestReceivedAt !== undefined) {
        text += ` Older mail may exist — call list_mail again with until: ${oldestReceivedAt}.`;
      }
      if (failures.length > 0) text += ` ${failures.length} wrap(s) could not be decoded.`;
      return ok(text, {
        mail: rows,
        count: messages.length,
        oldestReceivedAt,
        hasMore,
        failures,
      });
    },
  );

  server.registerTool(
    "read_mail",
    {
      description:
        "Read the full body of one message from your inbox by its id (from list_mail).",
      inputSchema: { mailId: z.string() },
    },
    async ({ mailId }: { mailId: string }) => {
      const msg = await mail.readMailById(mailId);
      if (!msg) {
        return fail(
          `No message with id "${mailId}". Use list_mail to see the ids in your inbox.`,
          "NOT_FOUND",
        );
      }
      const text = [
        `From: ${msg.from}`,
        `To: ${msg.to}`,
        `Subject: ${msg.subject}`,
        `Date: ${new Date(msg.receivedAt * 1000).toISOString()}`,
        "",
        msg.text,
      ].join("\n");
      return ok(text, {
        id: msg.wrapId,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        messageId: msg.messageId,
        receivedAt: msg.receivedAt,
      });
    },
  );

  server.registerTool(
    "who_is_my_mail_address",
    {
      description:
        "Show the account signed in to this server, its default mail address, and every alias " +
        "it can send as.",
      inputSchema: {},
    },
    async () => {
      const who = await mail.mailIdentity();
      const aliases = await mail.listAliases();
      const defaultFrom = await mail.defaultSenderAddress();
      return ok(
        `Signed in as ${who.npub}. Sending as ${defaultFrom}.` +
          (aliases.length
            ? ` Aliases: ${aliases.join(", ")}.`
            : " No registered alias yet — claim one with claim_mailbox."),
        { ...who, aliases, defaultFrom },
      );
    },
  );

  server.registerTool(
    "list_mail_aliases",
    {
      description:
        "List every mail address (NIP-05 alias) this account can send as, and which is the " +
        "default. All aliases share one inbox.",
      inputSchema: {},
    },
    async () => {
      const aliases = await mail.listAliases();
      const defaultFrom = await mail.defaultSenderAddress();
      return ok(
        aliases.length
          ? `You can send as ${aliases.length} address(es); default is ${defaultFrom}.`
          : `No aliases yet — sending uses ${defaultFrom}. Claim an address with claim_mailbox.`,
        { aliases, defaultFrom },
      );
    },
  );

  // ── Gated (outward / identity-changing) ───────────────
  write = true;

  server.registerTool(
    "send_mail",
    {
      description:
        "Send email from your mailstr identity. `to` may be a recipient's npub/hex key, or an " +
        "external email address (routed through the domain's SMTP bridge). Requires confirm:true.",
      inputSchema: {
        to: z.string(),
        subject: z.string().optional(),
        text: z.string().optional(),
        raw: z.string().optional(),
        from: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args: {
      to: string;
      subject?: string;
      text?: string;
      raw?: string;
      from?: string;
      confirm?: boolean;
    }) => {
      const blocked = requireConfirm("send_mail", args, `sends email to "${args.to}"`);
      if (blocked) return blocked;
      if (args.text === undefined && args.raw === undefined) {
        return fail("send_mail needs either `text` or `raw`.", "BAD_INPUT");
      }
      // If a From is given, it must be one this key can actually send as. The
      // bridge binds the seal pubkey to the From's NIP-05 record, so a typo or a
      // stranger's alias would bounce; name the valid choices instead.
      if (args.from !== undefined) {
        const identity = await mail.mailIdentity();
        const aliases = await mail.listAliases();
        const npubAddress = `${identity.npub}@${DEFAULT_MAIL_DOMAIN}`;
        const validSenders = [npubAddress, ...aliases];
        if (!validSenders.map((a) => a.toLowerCase()).includes(args.from.toLowerCase())) {
          return fail(
            `You cannot send as "${args.from}". Use one of: ${validSenders.join(", ")}.`,
            "BAD_SENDER",
          );
        }
      }
      try {
        const result = await mail.sendMail({
          to: args.to,
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.raw !== undefined ? { raw: args.raw } : {}),
          ...(args.from !== undefined ? { from: args.from } : {}),
        });
        const delivered = result.results.filter((r) => r.ok).length;
        return ok(
          `Sent to ${result.recipient}. Accepted by ${delivered}/${result.results.length} relay(s).`,
          { recipient: result.recipient, wrapId: result.wrap.id, results: result.results },
        );
      } catch (e) {
        return fail(`Could not send: ${e instanceof Error ? e.message : String(e)}`, "SEND_FAILED");
      }
    },
  );

  server.registerTool(
    "claim_mailbox",
    {
      description:
        "Start claiming a mailstr address like you@mailstr.app. Returns a Lightning invoice to " +
        "pay in any wallet — this server cannot pay it. Mail works once NIP-05 propagates. " +
        "Requires confirm:true.",
      inputSchema: {
        name: z.string(),
        tier: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args: { name: string; tier?: string; confirm?: boolean }) => {
      const blocked = requireConfirm(
        "claim_mailbox",
        args,
        `claims the address ${args.name}@mailstr.app for your identity (a Lightning payment you must make)`,
      );
      if (blocked) return blocked;
      const outcome = await mail.requestMailbox(
        args.tier !== undefined ? { name: args.name, tier: args.tier } : { name: args.name },
      );
      if ("error" in outcome) return fail(outcome.error, "CLAIM_FAILED");
      return ok(
        `Pay this Lightning invoice to receive ${outcome.nip05}, then it will begin working. ` +
          `Amount: ${outcome.amountSats ?? "unspecified"} sats.`,
        outcome,
      );
    },
  );

  server.registerTool(
    "publish_mail_setup",
    {
      description:
        "Publish the profile (with your NIP-05 address) and the kind-10050 DM-relay list senders " +
        "use to deliver mail to you. Requires confirm:true.",
      inputSchema: {
        name: z.string(),
        nip05: z.string().optional(),
        about: z.string().optional(),
        picture: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args: {
      name: string;
      nip05?: string;
      about?: string;
      picture?: string;
      confirm?: boolean;
    }) => {
      const blocked = requireConfirm(
        "publish_mail_setup",
        args,
        "publishes your profile and mail-delivery relay list",
      );
      if (blocked) return blocked;
      const { profile, dmRelays } = await mail.publishMailSetup({
        name: args.name,
        ...(args.nip05 !== undefined ? { nip05: args.nip05 } : {}),
        ...(args.about !== undefined ? { about: args.about } : {}),
        ...(args.picture !== undefined ? { picture: args.picture } : {}),
      });
      const okCount = (r: { ok: boolean }[]) => r.filter((x) => x.ok).length;
      return ok(
        `Published profile to ${okCount(profile.results)} relay(s) and DM relay list to ` +
          `${okCount(dmRelays.results)} relay(s).`,
        { profile, dmRelays },
      );
    },
  );

  return tools;
}
