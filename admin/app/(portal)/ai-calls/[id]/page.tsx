import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { CallBadge, CallUserLink, PhotoMissing } from "@/components/ai-call-bits";
import { RelativeDate } from "@/components/user-bits";
import {
  aiCallsHref,
  callUser,
  durationText,
  errorFirstLine,
  flagLabel,
  linkLabel,
  PHOTO_URL_SECONDS,
  prettyBody,
  signedUrlsByPath,
  statusLabel,
  taskLabel,
  tokensText,
} from "@/lib/ai-calls";
import { fullDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminAiCall, AdminAiCallLink } from "@/lib/types";
import { isUuid } from "@/lib/users";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "AI call · Back office" };

type Params = Promise<{ id: string }>;

// One AI call (spec 4.12), from admin_ai_call: who made it, the facts, the error, what we sent the
// model, what came back, the attempts linked to it and, for an AI photo, the photo. Opening it
// writes a `view_ai_call` audit row, so links here don't prefetch.
export default function AiCallPage({ params }: { params: Params }) {
  return (
    <>
      <Link
        href={aiCallsHref({ kind: "flagged" })}
        className="mb-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink-secondary hover:text-ink"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        AI calls
      </Link>
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading…</p>}>
        <CallDetail params={params} />
      </Suspense>
    </>
  );
}

async function CallDetail({ params }: { params: Params }) {
  const { id } = await params;
  if (!isUuid(id)) return <NoSuchCall />;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_ai_call", { p_id: id });
  forbidIfNotAuthorized(error);
  if (error?.code === "P0002") return <NoSuchCall />;
  if (error) throw new Error(`Couldn't load the AI call: ${error.message}`);
  const call = data as AdminAiCall;

  let photoUrl: string | null = null;
  if (call.photo_path) {
    const { data: signed } = await supabase.storage
      .from("recipe-photos")
      .createSignedUrls([call.photo_path], PHOTO_URL_SECONDS);
    photoUrl = signedUrlsByPath([call.photo_path], signed).get(call.photo_path) ?? null;
  }

  const user = callUser(call);
  const flagged = call.flag !== null;

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[34px] leading-tight text-ink">{taskLabel(call.task)}</h1>
          <CallBadge call={call} />
        </div>
        <p className="mt-1 text-[15px] text-ink-secondary">
          <CallUserLink user={user} /> · <RelativeDate iso={call.created_at} />
        </p>
        <p className="mt-0.5 font-mono text-[12px] text-ink-tertiary select-all">{call.id}</p>
        <p className="mt-2 text-[14px] text-ink-tertiary">Opening a call is recorded in Activity.</p>
      </header>

      <Card title="Facts">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[15px]">
          <Fact label="When">{fullDate(call.created_at)}</Fact>
          <Fact label="Task">
            {taskLabel(call.task)} <span className="font-mono text-[13px] text-ink-tertiary">{call.task}</span>
          </Fact>
          <Fact label="Model" mono>{call.model}</Fact>
          <Fact label="Prompt version" mono>{call.prompt_version}</Fact>
          <Fact label="Status">{statusLabel(call.status)}</Fact>
          <Fact label="Flag">{call.flag === null ? null : flagLabel(call.flag)}</Fact>
          <Fact label="HTTP status">{call.http_status}</Fact>
          <Fact label="Finish reason" mono>{call.finish_reason}</Fact>
          <Fact label="Provider's reason" mono>{call.raw_finish_reason}</Fact>
          <Fact label="Duration">{durationText(call.duration_ms)}</Fact>
          <Fact label="Tokens">{tokensText(call)}</Fact>
        </dl>
      </Card>

      {call.error && (
        <Card title="Error">
          <p className="mb-2 text-[15px] font-semibold text-danger">{errorFirstLine(call.error)}</p>
          <Pre>{call.error}</Pre>
        </Card>
      )}

      {call.photo_path && (
        <Card title="Photo">
          {photoUrl ? (
            // A signed, short-lived storage URL; next/image gains nothing here.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="The AI photo" className="max-h-[480px] rounded-xl object-contain" />
          ) : (
            <PhotoMissing className="aspect-video max-w-md rounded-xl" />
          )}
          <p className="mt-2 font-mono text-[12px] text-ink-tertiary select-all">{call.photo_path}</p>
        </Card>
      )}

      <Card title="What we sent">
        <Sent title="Instructions" text={call.instructions} open={flagged} />
        <Sent title="Prompt" text={call.prompt} open={flagged} />
      </Card>

      <Card title="What came back">
        <h3 className="mb-1 text-[15px] text-ink">Response</h3>
        <Pre>{prettyBody(call.response_text)}</Pre>
        <h3 className="mt-4 mb-1 text-[15px] text-ink">Error body</h3>
        <Pre>{prettyBody(call.error_body)}</Pre>
        {call.provider_metadata && (
          <>
            <h3 className="mt-4 mb-1 text-[15px] text-ink">Block details</h3>
            <Pre>{JSON.stringify(call.provider_metadata, null, 2)}</Pre>
          </>
        )}
      </Card>

      {(call.primary || call.fallback) && (
        <Card title="Linked attempts">
          <ul className="divide-y divide-border">
            {call.primary && <Attempt label={linkLabel("primary", call.task, call.primary.task)} link={call.primary} />}
            {call.fallback && <Attempt label={linkLabel("fallback", call.task, call.fallback.task)} link={call.fallback} />}
          </ul>
        </Card>
      )}
    </div>
  );
}

function NoSuchCall() {
  return (
    <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
      <h1 className="text-[28px] leading-tight text-ink">No such AI call</h1>
      <p className="mt-1 text-[15px] text-ink-secondary">Calls are kept for 30 days, flagged ones for 180.</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface p-5 shadow-sm">
      <h2 className="mb-3 text-[20px] leading-tight text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, mono = false, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  const empty = children === null || children === undefined || children === "";
  return (
    <>
      <dt className="text-ink-secondary">{label}</dt>
      <dd className={cn("min-w-0 break-words text-ink", mono && !empty && "font-mono text-[13px]")}>
        {empty ? <span className="text-ink-tertiary">—</span> : children}
      </dd>
    </>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="max-h-[480px] overflow-auto rounded-xl bg-background p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink">
      {children}
    </pre>
  );
}

// The instructions and the prompt in full: open for a flagged call, collapsed otherwise.
function Sent({ title, text, open }: { title: string; text: string; open: boolean }) {
  return (
    <details open={open} className="group mb-3 last:mb-0">
      <summary className="mb-1 cursor-pointer text-[15px] font-semibold text-ink">
        {title} <span className="font-normal text-ink-tertiary">· {text.length.toLocaleString("en-US")} characters</span>
      </summary>
      <Pre>{text}</Pre>
    </details>
  );
}

function Attempt({ label, link }: { label: string; link: AdminAiCallLink }) {
  const firstLine = errorFirstLine(link.error);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 py-2 text-[15px]">
      <span>
        <span className="font-semibold text-ink">{label}</span>{" "}
        <Link href={`/ai-calls/${link.id}`} prefetch={false} className="text-primary hover:underline">
          {taskLabel(link.task)} · <span className="font-mono text-[13px]">{link.model}</span>
        </Link>
      </span>
      <span className="text-ink-secondary" title={link.error ?? undefined}>
        {statusLabel(link.status)}
        {firstLine && ` · ${firstLine}`}
      </span>
    </li>
  );
}
