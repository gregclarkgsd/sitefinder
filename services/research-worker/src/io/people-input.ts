import { z } from "zod";
import type {
  AttioPersonSnapshot,
  PipedrivePersonSnapshot,
} from "../types.js";
import {
  parseCapturedJson,
  type ImmutableInput,
} from "./immutable-input.js";

const emailList = z.array(z.string().trim().min(1).max(320));

const attioPersonSchema = z
  .object({
    recordId: z.string().trim().min(1).max(256),
    name: z.string().max(500),
    emails: emailList,
    jobTitle: z.string().max(500),
    companyRecordIds: z.array(z.string().trim().min(1).max(256)),
  })
  .strict();

const pipedrivePersonSchema = z
  .object({
    personId: z.string().trim().min(1).max(256),
    name: z.string().max(500),
    emails: emailList,
    jobTitle: z.string().max(500),
    organizationId: z.string().trim().min(1).max(256).optional(),
    organizationName: z.string().max(500).optional(),
    labels: z.array(z.string().max(500)),
    noteDepartedSignal: z.literal(true).optional(),
  })
  .strict();

export function parseCapturedAttioPeople(
  input: ImmutableInput,
): AttioPersonSnapshot[] {
  return z.array(attioPersonSchema).parse(parseCapturedJson(input));
}

export function parseCapturedPipedrivePeople(
  input: ImmutableInput,
): PipedrivePersonSnapshot[] {
  return z
    .array(pipedrivePersonSchema)
    .parse(parseCapturedJson(input))
    .map((person) => ({
      personId: person.personId,
      name: person.name,
      emails: person.emails,
      jobTitle: person.jobTitle,
      labels: person.labels,
      ...(person.organizationId
        ? { organizationId: person.organizationId }
        : {}),
      ...(person.organizationName
        ? { organizationName: person.organizationName }
        : {}),
      ...(person.noteDepartedSignal
        ? { noteDepartedSignal: true as const }
        : {}),
    }));
}
