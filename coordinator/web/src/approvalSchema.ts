export type JsonObject = Record<string, unknown>;
export const objectValue = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
export type FormField = {
  key: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean;
  options?: { value: string; label: string }[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};
export type FormValues = Record<string, string | string[]>;
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
function optionsFor(schema: JsonObject): FormField["options"] {
  if (stringArray(schema.enum)) {
    const names = stringArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((value, index) => ({
      value,
      label: names[index] ?? value,
    }));
  }
  const choices = schema.oneOf ?? schema.anyOf;
  if (
    Array.isArray(choices) &&
    choices.every((choice) => {
      const item = objectValue(choice);
      return (
        item &&
        typeof item.const === "string" &&
        typeof item.title === "string" &&
        Object.keys(item).every((key) => ["const", "title"].includes(key))
      );
    })
  )
    return choices.map((choice) => ({
      value: (choice as JsonObject).const as string,
      label: (choice as JsonObject).title as string,
    }));
  return undefined;
}
export function parseFormSchema(value: unknown): {
  fields: FormField[];
  error?: string;
} {
  const schema = objectValue(value),
    properties = objectValue(schema?.properties);
  if (!schema || schema.type !== "object" || !properties)
    return {
      fields: [],
      error: "This request uses a form structure this client cannot render.",
    };
  const rootKeys = [
    "$schema",
    "type",
    "properties",
    "required",
    "title",
    "description",
    "additionalProperties",
  ];
  if (
    Object.keys(schema).some((key) => !rootKeys.includes(key)) ||
    (schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false)
  )
    return {
      fields: [],
      error: "This form contains unsupported schema rules.",
    };
  if (schema.required !== undefined && !stringArray(schema.required))
    return {
      fields: [],
      error: "This form has an invalid required-field definition.",
    };
  const required = (schema.required ?? []) as string[];
  if (
    required.some((key) => !Object.hasOwn(properties, key)) ||
    Object.keys(properties).length > 50
  )
    return {
      fields: [],
      error: "This form cannot be represented completely by this client.",
    };
  const fields: FormField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const field = objectValue(raw);
    if (
      !field ||
      !["string", "number", "integer", "boolean", "array"].includes(
        String(field.type),
      )
    )
      return {
        fields: [],
        error: `The field “${key}” uses an unsupported type.`,
      };
    const allowed = [
      "type",
      "title",
      "description",
      "default",
      "minLength",
      "maxLength",
      "format",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
      "enum",
      "enumNames",
      "oneOf",
      "items",
    ];
    if (Object.keys(field).some((item) => !allowed.includes(item)))
      return {
        fields: [],
        error: `The field “${key}” contains unsupported validation rules.`,
      };
    if (field.enumNames !== undefined && !stringArray(field.enumNames))
      return {
        fields: [],
        error: `The choice labels for “${key}” are invalid.`,
      };
    if (field.type === "array") {
      const items = objectValue(field.items);
      if (
        !items ||
        Object.keys(items).some(
          (item) => !["type", "enum", "anyOf"].includes(item),
        ) ||
        (items.type !== undefined && items.type !== "string")
      )
        return {
          fields: [],
          error: `The items for “${key}” contain unsupported rules.`,
        };
    }
    const options =
      field.type === "array"
        ? optionsFor(objectValue(field.items) ?? {})
        : optionsFor(field);
    if (
      (field.type === "array" ||
        field.enum !== undefined ||
        field.oneOf !== undefined) &&
      !options
    )
      return {
        fields: [],
        error: `The choices for “${key}” cannot be represented completely.`,
      };
    if (
      options &&
      (options.length === 0 ||
        options.length > 100 ||
        (field.type !== "string" && field.type !== "array"))
    )
      return {
        fields: [],
        error: `The choices for “${key}” are not supported.`,
      };
    if (
      field.format !== undefined &&
      (field.type !== "string" ||
        !["email", "uri", "date", "date-time"].includes(String(field.format)))
    )
      return { fields: [], error: `The format for “${key}” is not supported.` };
    for (const constraint of [
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
    ]) {
      if (
        field[constraint] !== undefined &&
        (typeof field[constraint] !== "number" ||
          !Number.isFinite(field[constraint]))
      )
        return {
          fields: [],
          error: `The validation for “${key}” is not supported.`,
        };
    }
    fields.push({
      key,
      title: typeof field.title === "string" ? field.title : key,
      description:
        typeof field.description === "string" ? field.description : undefined,
      type: field.type as FormField["type"],
      required: required.includes(key),
      options,
      format: field.format as string | undefined,
      minLength: field.minLength as number | undefined,
      maxLength: field.maxLength as number | undefined,
      minimum: field.minimum as number | undefined,
      maximum: field.maximum as number | undefined,
      minItems: field.minItems as number | undefined,
      maxItems: field.maxItems as number | undefined,
    });
  }
  return { fields };
}
export function formContent(
  fields: FormField[],
  values: FormValues,
): { content: Record<string, unknown>; error?: string } {
  const content: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const raw = values[field.key];
    if (
      raw === undefined ||
      (raw === "" &&
        (field.type === "boolean" ||
          !!field.options ||
          field.type === "number" ||
          field.type === "integer"))
    ) {
      if (field.type === "array" && field.required && !field.minItems) {
        content[field.key] = [];
        continue;
      }
      if (field.required)
        return { content, error: `Complete “${field.title}”.` };
      continue;
    }
    if (field.type === "array") {
      if (
        !Array.isArray(raw) ||
        new Set(raw).size !== raw.length ||
        raw.some(
          (item) => !field.options?.some((option) => option.value === item),
        )
      )
        return { content, error: `Choose valid options for “${field.title}”.` };
      if (
        (field.minItems !== undefined && raw.length < field.minItems) ||
        (field.maxItems !== undefined && raw.length > field.maxItems)
      )
        return {
          content,
          error: `Check the number of choices for “${field.title}”.`,
        };
      content[field.key] = raw;
      continue;
    }
    if (typeof raw !== "string")
      return { content, error: `Check “${field.title}”.` };
    if (field.type === "boolean") {
      if (!["true", "false"].includes(raw))
        return { content, error: `Choose Yes or No for “${field.title}”.` };
      content[field.key] = raw === "true";
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      const number = Number(raw);
      if (
        !raw.trim() ||
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isInteger(number)) ||
        (field.minimum !== undefined && number < field.minimum) ||
        (field.maximum !== undefined && number > field.maximum)
      )
        return {
          content,
          error: `Enter a valid ${field.type === "integer" ? "whole number" : "number"} for “${field.title}”.`,
        };
      content[field.key] = number;
      continue;
    }
    if (field.options && !field.options.some((option) => option.value === raw))
      return { content, error: `Choose a valid option for “${field.title}”.` };
    if (
      (field.minLength !== undefined && raw.length < field.minLength) ||
      (field.maxLength !== undefined && raw.length > field.maxLength)
    )
      return { content, error: `Check the text length for “${field.title}”.` };
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw))
      return { content, error: `Enter an email address for “${field.title}”.` };
    if (field.format === "uri") {
      try {
        new URL(raw);
      } catch {
        return { content, error: `Enter a complete URL for “${field.title}”.` };
      }
    }
    if (
      field.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw)))
    )
      return { content, error: `Enter a date for “${field.title}”.` };
    if (field.format === "date-time" && !Number.isFinite(Date.parse(raw)))
      return { content, error: `Enter a date and time for “${field.title}”.` };
    content[field.key] = raw;
  }
  return { content };
}
export type PermissionChoice = {
  id: string;
  label: string;
  detail: string;
  kind: "network" | "read" | "write" | "entry";
  value: unknown;
};
export function permissionChoices(value: unknown): {
  choices: PermissionChoice[];
  denied: unknown[];
  depth?: number;
  error?: string;
} {
  const request = objectValue(value);
  const choices: PermissionChoice[] = [];
  const denied: unknown[] = [];
  if (
    !request ||
    Object.keys(request).some((key) => !["network", "fileSystem"].includes(key))
  )
    return {
      choices,
      denied,
      error: "This request has unsupported permission categories.",
    };
  if (request.network !== null && request.network !== undefined) {
    const network = objectValue(request.network);
    if (
      !network ||
      Object.keys(network).some((key) => key !== "enabled") ||
      (network.enabled !== true &&
        network.enabled !== false &&
        network.enabled !== null)
    )
      return {
        choices,
        denied,
        error: "The requested network permissions could not be represented.",
      };
    if (network.enabled === true)
      choices.push({
        id: "network",
        kind: "network",
        label: "Network access",
        detail: "Allow network access for the scope selected below.",
        value: true,
      });
  }
  const files =
    request.fileSystem === null || request.fileSystem === undefined
      ? undefined
      : objectValue(request.fileSystem);
  if (request.fileSystem !== null && request.fileSystem !== undefined && !files)
    return {
      choices: [],
      denied,
      error: "The filesystem permission request is invalid.",
    };
  if (files) {
    if (
      Object.keys(files).some(
        (key) =>
          !["read", "write", "entries", "globScanMaxDepth"].includes(key),
      )
    )
      return {
        choices: [],
        denied,
        error: "This request has unsupported filesystem permission rules.",
      };
    for (const kind of ["read", "write"] as const) {
      const paths = files[kind];
      if (paths === null || paths === undefined) continue;
      if (!stringArray(paths))
        return {
          choices: [],
          denied,
          error: "The requested filesystem paths could not be represented.",
        };
      paths.forEach((path, index) =>
        choices.push({
          id: `${kind}-${index}`,
          kind,
          label: kind === "read" ? "Read files" : "Write files",
          detail: path,
          value: path,
        }),
      );
    }
    if (files.entries !== undefined) {
      if (!Array.isArray(files.entries))
        return {
          choices: [],
          denied,
          error: "The requested filesystem entries are invalid.",
        };
      for (const [index, value] of files.entries.entries()) {
        const entry = objectValue(value),
          path = objectValue(entry?.path);
        if (
          !entry ||
          !path ||
          !["read", "write", "deny"].includes(String(entry.access)) ||
          Object.keys(entry).some((key) => !["path", "access"].includes(key))
        )
          return {
            choices: [],
            denied,
            error: "A filesystem entry could not be represented.",
          };
        let detail: string;
        if (
          path.type === "path" &&
          typeof path.path === "string" &&
          Object.keys(path).every((key) => ["type", "path"].includes(key))
        )
          detail = path.path;
        else if (
          path.type === "glob_pattern" &&
          typeof path.pattern === "string" &&
          Object.keys(path).every((key) => ["type", "pattern"].includes(key))
        )
          detail = `Pattern: ${path.pattern}`;
        else if (
          path.type === "special" &&
          objectValue(path.value) &&
          Object.keys(path).every((key) => ["type", "value"].includes(key))
        )
          detail = `Special paths: ${JSON.stringify(path.value)}`;
        else
          return {
            choices: [],
            denied,
            error: "A filesystem path type is unsupported.",
          };
        if (entry.access === "deny") denied.push(value);
        else
          choices.push({
            id: `entry-${index}`,
            kind: "entry",
            label: entry.access === "read" ? "Read files" : "Write files",
            detail,
            value,
          });
      }
    }
    if (
      files.globScanMaxDepth !== undefined &&
      (!Number.isInteger(files.globScanMaxDepth) ||
        Number(files.globScanMaxDepth) < 0)
    )
      return {
        choices: [],
        denied,
        error: "The filesystem scan limit is unsupported.",
      };
  }
  return {
    choices,
    denied,
    depth: files?.globScanMaxDepth as number | undefined,
  };
}
export function grantedPermissions(
  parsed: ReturnType<typeof permissionChoices>,
  selected: string[],
) {
  const permissions: Record<string, unknown> = {};
  const files: Record<string, unknown> = {};
  for (const choice of parsed.choices.filter((choice) =>
    selected.includes(choice.id),
  )) {
    if (choice.kind === "network") permissions.network = { enabled: true };
    else if (choice.kind === "entry")
      files.entries = [
        ...((files.entries as unknown[] | undefined) ?? []),
        choice.value,
      ];
    else
      files[choice.kind] = [
        ...((files[choice.kind] as unknown[] | undefined) ?? []),
        choice.value,
      ];
  }
  if (Object.keys(files).length) {
    files.read ??= null;
    files.write ??= null;
    if (parsed.denied.length)
      files.entries = [
        ...((files.entries as unknown[] | undefined) ?? []),
        ...parsed.denied,
      ];
    if (parsed.depth !== undefined) files.globScanMaxDepth = parsed.depth;
    permissions.fileSystem = files;
  }
  return permissions;
}

export function offeredPersistenceModes(
  value: unknown,
): ("session" | "always")[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (mode): mode is "session" | "always" =>
          mode === "session" || mode === "always",
      ),
    ),
  ];
}
export function elicitationResponseMeta(
  mode: string,
  action: string,
  offered: unknown,
  selected: string,
) {
  return mode === "form" &&
    action === "accept" &&
    (selected === "session" || selected === "always") &&
    offeredPersistenceModes(offered).includes(selected)
    ? { persist: selected }
    : null;
}
