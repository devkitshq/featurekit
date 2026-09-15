/**
 * Dashboard accounts, from a terminal (dashboard/PLAN.md §2.3).
 *
 *   node scripts/admin-user.mjs list
 *   node scripts/admin-user.mjs create <email> [--role owner|admin|writer|reader]
 *   node scripts/admin-user.mjs password <email>
 *   node scripts/admin-user.mjs role <email> <role>
 *   node scripts/admin-user.mjs delete <email>
 *
 * The password is read from the terminal with echo off, or from
 * `FEATKIT_PASSWORD` for a non-interactive run. It is never taken as an
 * argument: arguments are in `ps`, in shell history, and in CI logs.
 */

import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "../dist/db/client.js";
import {
  createMember,
  deleteMember,
  deleteSessionsFor,
  findMemberByEmail,
  listMembers,
  ownerCount,
  updateMember,
} from "../dist/repositories/members.js";
import { PasswordError, MIN_PASSWORD_LENGTH } from "../dist/auth/passwords.js";

const ROLES = ["owner", "admin", "writer", "reader"];

async function databaseUrl() {
  if (process.env["DATABASE_URL"] !== undefined) return process.env["DATABASE_URL"];
  try {
    // A development server records the Postgres it resolved, which may be on a
    // port it chose. Without this the CLI would talk to a different database
    // than the server and report that the account it just made does not exist.
    const state = JSON.parse(
      await readFile(join(process.cwd(), ".featkit", "dev.json"), "utf8").catch(() =>
        readFile(join(process.cwd(), ".featurekit", "dev.json"), "utf8"),
      ),
    );
    if (typeof state.databaseUrl === "string") return state.databaseUrl;
  } catch {
    /* no dev state; fall through to the default */
  }
  return "postgres://featkit:featkit@127.0.0.1:5432/featkit";
}

/** Read a line with the terminal's echo turned off. */
async function readPassword(prompt) {
  const fromEnv = process.env["FEATKIT_PASSWORD"] ?? process.env["FEATUREKIT_PASSWORD"];
  if (fromEnv !== undefined) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error("no TTY: set FEATKIT_PASSWORD to run this non-interactively");
  }

  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // `_writeToOutput` is readline's own hook for exactly this; there is no
  // public API for a hidden prompt in Node.
  rl._writeToOutput = () => {};
  const value = await new Promise((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return value;
}

async function askPasswordTwice() {
  const first = await readPassword(`password (min ${MIN_PASSWORD_LENGTH} chars): `);
  if (process.env["FEATUREKIT_PASSWORD"] !== undefined) return first;
  const second = await readPassword("again: ");
  if (first !== second) throw new Error("passwords did not match");
  return first;
}

const [command, ...args] = process.argv.slice(2);
const role = (() => {
  const at = process.argv.indexOf("--role");
  return at === -1 ? "writer" : process.argv[at + 1];
})();

const { db, close } = createDatabase({ url: await databaseUrl(), maxConnections: 2 });

try {
  switch (command) {
    case "list": {
      const members = await listMembers(db);
      if (members.length === 0) {
        console.log("  no accounts yet — create one with `create <email>`");
        break;
      }
      for (const member of members) {
        const last = member.lastLoginAt === null ? "never" : member.lastLoginAt.toISOString();
        console.log(
          `  ${member.email.padEnd(32)} ${member.role.padEnd(7)} ` +
            `${member.hasPassword ? "password" : "token-only"}  last login: ${last}`,
        );
      }
      break;
    }

    case "create": {
      const email = required(args[0], "email");
      if (!ROLES.includes(role)) fail(`role must be one of: ${ROLES.join(", ")}`);
      if ((await findMemberByEmail(db, email)) !== null) fail(`${email} already exists`);
      const password = await askPasswordTwice();
      const member = await createMember(db, { email, role, password, name: null });
      console.log(`  created ${member.email} (${member.role})`);
      break;
    }

    case "password": {
      const email = required(args[0], "email");
      const member = await findMemberByEmail(db, email);
      if (member === null) fail(`no such member: ${email}`);
      const password = await askPasswordTwice();
      await updateMember(db, member.id, { password });
      // `updateMember` already ends their sessions; saying so is the point.
      console.log(`  password changed for ${email}; every session for it is now invalid`);
      break;
    }

    case "role": {
      const email = required(args[0], "email");
      const next = required(args[1], "role");
      if (!ROLES.includes(next)) fail(`role must be one of: ${ROLES.join(", ")}`);
      const member = await findMemberByEmail(db, email);
      if (member === null) fail(`no such member: ${email}`);
      if (member.role === "owner" && next !== "owner" && (await ownerCount(db, member.id)) === 0) {
        fail("this is the only owner; promote somebody else first");
      }
      await updateMember(db, member.id, { role: next });
      console.log(`  ${email} is now ${next}`);
      break;
    }

    case "delete": {
      const email = required(args[0], "email");
      const member = await findMemberByEmail(db, email);
      if (member === null) fail(`no such member: ${email}`);
      if (member.role === "owner" && (await ownerCount(db, member.id)) === 0) {
        fail("this is the only owner; promote somebody else first");
      }
      await deleteSessionsFor(db, member.id);
      await deleteMember(db, member.id);
      console.log(`  removed ${email}`);
      break;
    }

    default:
      console.log(
        [
          "featkit accounts",
          "",
          "  node scripts/admin-user.mjs list",
          "  node scripts/admin-user.mjs create <email> [--role owner|admin|writer|reader]",
          "  node scripts/admin-user.mjs password <email>",
          "  node scripts/admin-user.mjs role <email> <role>",
          "  node scripts/admin-user.mjs delete <email>",
        ].join("\n"),
      );
      if (command !== undefined) process.exitCode = 2;
  }
} catch (error) {
  const message = error instanceof PasswordError ? error.message : String(error?.message ?? error);
  process.stderr.write(`featkit: ${message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}

function required(value, what) {
  if (value === undefined || value.length === 0) fail(`${what} is required`);
  return value;
}

function fail(message) {
  process.stderr.write(`featkit: ${message}\n`);
  process.exit(1);
}
