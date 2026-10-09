import { useState } from "react";
import {
  Check,
  CircleHelp,
  ExternalLink,
  LoaderCircle,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Approval, Task } from "./types";
import {
  formContent,
  grantedPermissions,
  objectValue,
  parseFormSchema,
  permissionChoices,
  offeredPersistenceModes,
  elicitationResponseMeta,
} from "./approvalSchema";
import type { FormField, FormValues } from "./approvalSchema";

const text = (value: unknown) => (typeof value === "string" ? value : "");
type Submit = (body: unknown) => Promise<void>;
function ResponseButtons({
  busy,
  onDecline,
  onCancel,
}: {
  busy: boolean;
  onDecline?: () => void;
  onCancel?: () => void;
}) {
  return (
    <>
      {onDecline && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onDecline}
        >
          Decline
        </button>
      )}
      {onCancel && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={12} />
          Cancel request
        </button>
      )}
    </>
  );
}
function ElicitationField({
  field,
  values,
  setValues,
  disabled,
}: {
  field: FormField;
  values: FormValues;
  setValues: (values: FormValues) => void;
  disabled: boolean;
}) {
  const value = values[field.key];
  const label = `${field.title}${field.required ? " *" : ""}`;
  const description = field.description ? (
    <small className="form-field-description">{field.description}</small>
  ) : null;
  if (field.type === "array")
    return (
      <fieldset className="elicitation-field">
        <legend>{label}</legend>
        {description}
        {field.options?.map((option) => (
          <label className="decision-option" key={option.value}>
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(option.value)}
              disabled={disabled}
              onChange={(event) => {
                const previous = Array.isArray(value) ? value : [];
                setValues({
                  ...values,
                  [field.key]: event.target.checked
                    ? [...previous, option.value]
                    : previous.filter((item) => item !== option.value),
                });
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {(field.minItems !== undefined || field.maxItems !== undefined) && (
          <small className="form-field-description">
            {field.minItems !== undefined ? `At least ${field.minItems}. ` : ""}
            {field.maxItems !== undefined ? `At most ${field.maxItems}.` : ""}
          </small>
        )}
      </fieldset>
    );
  return (
    <label className="elicitation-field">
      <span>{label}</span>
      {description}
      {field.type === "boolean" || field.options ? (
        <select
          className="input"
          aria-label={field.title}
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          onChange={(event) =>
            setValues({ ...values, [field.key]: event.target.value })
          }
        >
          <option value="">Choose an option</option>
          {field.type === "boolean" ? (
            <>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </>
          ) : (
            field.options?.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))
          )}
        </select>
      ) : (
        <input
          className="input"
          aria-label={field.title}
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          type={
            field.type === "number" || field.type === "integer"
              ? "number"
              : field.format === "email"
                ? "email"
                : field.format === "date"
                  ? "date"
                  : "text"
          }
          step={field.type === "integer" ? 1 : "any"}
          min={field.minimum}
          max={field.maximum}
          minLength={field.minLength}
          maxLength={field.maxLength}
          placeholder={
            field.format === "date-time"
              ? "YYYY-MM-DDTHH:mm:ssZ"
              : field.format === "uri"
                ? "https://…"
                : undefined
          }
          onChange={(event) =>
            setValues({ ...values, [field.key]: event.target.value })
          }
        />
      )}
    </label>
  );
}
function ElicitationForm({
  approval,
  busy,
  submit,
}: {
  approval: Approval;
  busy: boolean;
  submit: Submit;
}) {
  const [values, setValues] = useState<FormValues>({});
  const [error, setError] = useState("");
  const [persistence, setPersistence] = useState("");
  const details = approval.details;
  const mode = text(details.mode);
  const schema = parseFormSchema(details.requestedSchema);
  const persistenceModes = offeredPersistenceModes(details.persistenceModes);
  const unsupported =
    text(details.unsupportedReason) ||
    (mode === "form"
      ? (schema.error ?? "")
      : mode === "url"
        ? ""
        : "This request format needs a client feature that Providence has not implemented.");
  let url: URL | undefined;
  try {
    const candidate = new URL(text(details.url));
    if (
      ["https:", "http:"].includes(candidate.protocol) &&
      !candidate.username &&
      !candidate.password
    )
      url = candidate;
  } catch {}
  const respond = (
    action: "accept" | "decline" | "cancel",
    content: unknown = null,
  ) =>
    submit({
      response: {
        kind: "elicitation",
        action,
        content,
        _meta: elicitationResponseMeta(
          mode,
          action,
          details.persistenceModes,
          persistence,
        ),
      },
    });
  return (
    <div className="elicitation-form">
      {text(details.message) && (
        <p className="approval-message">{text(details.message)}</p>
      )}
      {text(details.title) && <h4>{text(details.title)}</h4>}
      {text(details.description) && (
        <p className="approval-message">{text(details.description)}</p>
      )}
      {unsupported ? (
        <>
          <p className="unsupported-request">{unsupported}</p>
          <details className="request-schema">
            <summary>View requested form structure</summary>
            <pre>
              {JSON.stringify(
                details.requestedSchema ?? { mode },
                null,
                2,
              ).slice(0, 18000)}
            </pre>
          </details>
          <div className="button-row">
            <ResponseButtons
              busy={busy}
              onDecline={() => void respond("decline")}
              onCancel={() => void respond("cancel")}
            />
          </div>
        </>
      ) : mode === "url" ? (
        <>
          <p className="form-field-description">
            Open the requested service, complete its step, then explicitly
            confirm here.
          </p>
          {url ? (
            <a
              className="approval-external-link"
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>{url.href}</span>
              <ExternalLink size={13} />
            </a>
          ) : (
            <p className="unsupported-request">
              This request does not contain a supported HTTP or HTTPS link.
            </p>
          )}
          <div className="button-row">
            {url && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void respond("accept")}
              >
                I completed this step
              </button>
            )}
            <ResponseButtons
              busy={busy}
              onDecline={() => void respond("decline")}
              onCancel={() => void respond("cancel")}
            />
          </div>
        </>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const result = formContent(schema.fields, values);
            setError(result.error ?? "");
            if (!result.error) void respond("accept", result.content);
          }}
        >
          {schema.fields.map((field) => (
            <ElicitationField
              key={field.key}
              field={field}
              values={values}
              setValues={setValues}
              disabled={busy}
            />
          ))}
          {persistenceModes.length > 0 && (
            <label className="elicitation-field response-persistence">
              <span>Remember this choice</span>
              <select
                className="input"
                aria-label="Remember this choice"
                disabled={busy}
                value={persistence}
                onChange={(event) => setPersistence(event.target.value)}
              >
                <option value="">This request only</option>
                {persistenceModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === "session" ? "For this session" : "Always"}
                  </option>
                ))}
              </select>
              <small className="form-field-description">
                These duration options were offered by this service.
              </small>
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="button-row">
            <button className="button primary" disabled={busy}>
              <Send size={13} />
              Submit response
            </button>
            <ResponseButtons
              busy={busy}
              onDecline={() => void respond("decline")}
              onCancel={() => void respond("cancel")}
            />
          </div>
        </form>
      )}
    </div>
  );
}
function PermissionForm({
  approval,
  busy,
  submit,
}: {
  approval: Approval;
  busy: boolean;
  submit: Submit;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [scope, setScope] = useState<"turn" | "session">("turn");
  const parsed = permissionChoices(approval.details.permissions);
  const error = text(approval.details.unsupportedReason) || parsed.error;
  return (
    <div className="permission-form">
      <p className="approval-message">
        Select the requested access to grant. Unselected permissions are not
        granted.
      </p>
      {error ? (
        <p className="unsupported-request">{error}</p>
      ) : (
        <>
          {parsed.choices.map((choice) => (
            <label
              className="decision-option permission-choice"
              key={choice.id}
            >
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.includes(choice.id)}
                onChange={(event) =>
                  setSelected((previous) =>
                    event.target.checked
                      ? [...previous, choice.id]
                      : previous.filter((id) => id !== choice.id),
                  )
                }
              />
              <span>
                <strong>{choice.label}</strong>
                <small className={choice.kind === "network" ? "" : "mono"}>
                  {choice.detail}
                </small>
              </span>
            </label>
          ))}
          {!parsed.choices.length && (
            <p className="form-field-description">
              No additional supported access was requested.
            </p>
          )}
          {parsed.denied.length > 0 && (
            <details className="request-schema">
              <summary>
                {parsed.denied.length} filesystem{" "}
                {parsed.denied.length === 1
                  ? "exclusion stays"
                  : "exclusions stay"}{" "}
                in place
              </summary>
              <pre>{JSON.stringify(parsed.denied, null, 2)}</pre>
            </details>
          )}
          {parsed.depth !== undefined && (
            <p className="form-field-description">
              File pattern scan depth: {parsed.depth}.
            </p>
          )}
          <label className="elicitation-field">
            <span>Permission scope</span>
            <select
              className="input"
              aria-label="Permission scope"
              disabled={busy}
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as "turn" | "session")
              }
            >
              <option value="turn">This turn only</option>
              <option value="session">
                This conversation session, including later turns
              </option>
            </select>
          </label>
          {scope === "session" && (
            <p className="scope-note">
              Selected access will also apply to later turns in this
              conversation session.
            </p>
          )}
        </>
      )}
      <div className="button-row">
        {!error && (
          <button
            className="button primary"
            disabled={busy || !selected.length}
            onClick={() =>
              void submit({
                response: {
                  kind: "permissions",
                  permissions: grantedPermissions(parsed, selected),
                  scope,
                },
              })
            }
          >
            <ShieldCheck size={14} />
            Grant selected access
          </button>
        )}
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void submit({
              response: { kind: "permissions", permissions: {}, scope: "turn" },
            })
          }
        >
          Deny permissions
        </button>
      </div>
    </div>
  );
}
function LegacyAccessDetails({ approval }: { approval: Approval }) {
  const details = approval.details;
  const grantRoot = text(details.grantRoot);
  const network = objectValue(details.networkApprovalContext);
  const hasAdditional =
    details.additionalPermissions !== null &&
    details.additionalPermissions !== undefined;
  const additional = hasAdditional
    ? permissionChoices(details.additionalPermissions)
    : undefined;
  return (
    <>
      {grantRoot && (
        <div className="legacy-access">
          <strong>Session write access requested</strong>
          <p>
            Allow writes under this folder for the remainder of the session:
          </p>
          <pre>{grantRoot}</pre>
        </div>
      )}
      {network && (
        <div className="legacy-access">
          <strong>Network destination under review</strong>
          <dl>
            <dt>Host</dt>
            <dd className="mono">{text(network.host)}</dd>
            <dt>Protocol</dt>
            <dd>{text(network.protocol)}</dd>
          </dl>
        </div>
      )}
      {additional && (
        <div className="legacy-access">
          <strong>Additional access requested for this command</strong>
          {additional.error ? (
            <>
              <p>{additional.error}</p>
              <pre>
                {JSON.stringify(details.additionalPermissions, null, 2).slice(
                  0,
                  18000,
                )}
              </pre>
            </>
          ) : (
            <>
              {additional.choices.map((choice) => (
                <dl key={choice.id}>
                  <dt>{choice.label}</dt>
                  <dd className={choice.kind === "network" ? "" : "mono"}>
                    {choice.detail}
                  </dd>
                </dl>
              ))}
              {additional.denied.length > 0 && (
                <details className="request-schema">
                  <summary>Filesystem exclusions</summary>
                  <pre>{JSON.stringify(additional.denied, null, 2)}</pre>
                </details>
              )}
              {additional.depth !== undefined && (
                <p>File pattern scan depth: {additional.depth}.</p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Request kind describes its source/shape, never whether confirmation is optional. */
export function approvalRequestLabel(approval: Approval): string {
  if (approval.method === "mcpServer/elicitation/request" || approval.details.kind === "elicitation")
    return "App or service request";
  if (approval.method === "item/permissions/requestApproval" || approval.details.kind === "permissions")
    return "Device permissions requested";
  if (approval.method === "item/commandExecution/requestApproval") return "Command permission requested";
  if (approval.method === "item/fileChange/requestApproval") return "File change permission requested";
  if (approval.method.includes("requestUserInput") || (approval.details.questions?.length ?? 0) > 0)
    return "Input requested";
  return "Request needs review";
}

export default function ApprovalCard({
  approval,
  task,
  deviceName,
  onResolve,
}: {
  approval: Approval;
  task?: Task;
  deviceName: string;
  onResolve: (id: string, body: unknown) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const details = approval.details;
  const isElicitation =
    approval.method === "mcpServer/elicitation/request" ||
    details.kind === "elicitation";
  const isPermissions =
    approval.method === "item/permissions/requestApproval" ||
    details.kind === "permissions";
  const questions = details.questions ?? [];
  const isQuestion =
    !isElicitation &&
    !isPermissions &&
    (approval.method.includes("requestUserInput") || questions.length > 0);
  const deadline = details.replyDeadlineAt;
  const timedQuestion = approval.method === "item/tool/requestUserInput" && details.isBlocking !== true &&
    typeof deadline === "string" && Number.isFinite(Date.parse(deadline)) && new Date(deadline).toISOString() === deadline;
  const knownAction = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ].includes(approval.method);
  const advertised = details.availableDecisions;
  const basicDecisions =
    advertised == null
      ? ["accept", "decline", "cancel"]
      : Array.isArray(advertised)
        ? advertised.filter(
            (value) =>
              typeof value === "string" &&
              ["accept", "decline", "cancel"].includes(value),
          )
        : [];
  const disabled = busy || submitted || approval.status !== "pending";
  async function submit(body: unknown) {
    if (disabled) return;
    setBusy(true);
    setError("");
    try {
      await onResolve(approval.id, body);
      setSubmitted(true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Your response could not be submitted.",
      );
    } finally {
      setBusy(false);
    }
  }
  const command = Array.isArray(details.command)
    ? details.command.join(" ")
    : details.command;
  return (
    <section
      className="decision-card"
      aria-label={approvalRequestLabel(approval)}
    >
      <div className="decision-top">
        <CircleHelp size={17} />
        <span>
          {approvalRequestLabel(approval)}
        </span>
      </div>
      <p className="decision-context">
        {deviceName}
        <span> · </span>
        {task?.prompt ?? "Current task"}
      </p>
      {text(details.serverName) && (
        <p className="approval-source">
          <strong>Service</strong>
          {text(details.serverName)}
        </p>
      )}
      {text(details.reason) && (
        <p className="approval-message">{text(details.reason)}</p>
      )}
      {command && <pre>{command}</pre>}
      {details.cwd && <p className="mono small muted">{details.cwd}</p>}
      {knownAction && <LegacyAccessDetails approval={approval} />}
      {submitted || approval.status !== "pending" ? (
        <p className="decision-submitted">
          {submitted
            ? "Response submitted. Waiting for the task to update."
            : "This request is no longer pending."}
        </p>
      ) : isElicitation ? (
        <ElicitationForm approval={approval} busy={disabled} submit={submit} />
      ) : isPermissions ? (
        <PermissionForm approval={approval} busy={disabled} submit={submit} />
      ) : isQuestion ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit({
              answers: Object.fromEntries(
                questions.map((q) => [
                  q.id,
                  { answers: [answers[q.id]?.trim()] },
                ]),
              ),
            });
          }}
        >
          {timedQuestion && <p className="approval-message">Closes after up to 20 seconds without a reply.</p>}
          {questions.map((q) => (
            <fieldset key={q.id}>
              <legend>{q.question}</legend>
              {q.options?.map((option, index) => (
                <label
                  className={`decision-option ${answers[q.id] === option.label ? "chosen" : ""}`}
                  key={index}
                >
                  <input
                    type="radio"
                    name={`${approval.id}-${q.id}`}
                    disabled={disabled}
                    checked={answers[q.id] === option.label}
                    onChange={() =>
                      setAnswers({ ...answers, [q.id]: option.label })
                    }
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              <input
                className="input"
                aria-label={`Your answer: ${q.question}`}
                type={q.isSecret ? "password" : "text"}
                disabled={disabled}
                placeholder={
                  q.options?.length
                    ? "Or write your answer…"
                    : "Write your answer…"
                }
                value={
                  q.options?.some((option) => option.label === answers[q.id])
                    ? ""
                    : (answers[q.id] ?? "")
                }
                onChange={(event) =>
                  setAnswers({ ...answers, [q.id]: event.target.value })
                }
              />
            </fieldset>
          ))}
          <button
            className="button primary"
            disabled={
              disabled ||
              !questions.length ||
              questions.some((q) => !answers[q.id]?.trim())
            }
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Send size={14} />
            )}
            Submit response
          </button>
        </form>
      ) : (
        <div className="button-row">
          {knownAction && basicDecisions.includes("accept") && (
            <button
              className="button primary"
              disabled={disabled}
              onClick={() => void submit({ decision: "accept" })}
            >
              <Check size={14} />
              {text(details.grantRoot)
                ? "Allow requested session writes"
                : details.networkApprovalContext
                  ? "Allow network request"
                  : "Allow this action"}
            </button>
          )}
          <ResponseButtons
            busy={disabled}
            onDecline={
              basicDecisions.includes("decline")
                ? () => void submit({ decision: "decline" })
                : undefined
            }
            onCancel={
              basicDecisions.includes("cancel")
                ? () => void submit({ decision: "cancel" })
                : undefined
            }
          />
          {!basicDecisions.length && (
            <p className="unsupported-request">
              The provider offered no response options supported by this client. Use
              Stop on this task, or complete the request in the provider’s
              interface.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="decision-id">
        Request {approval.id.slice(0, 8)} · task {approval.taskId.slice(0, 8)}
      </p>
    </section>
  );
}
