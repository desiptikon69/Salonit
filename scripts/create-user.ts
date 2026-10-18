import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { first, pool, transaction } from "../src/server/db";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4) throw new Error("Usage: create-user <email> <name> <owner|admin|master|stock|accountant|operator> [staffId]. Set SALONIT_USER_PASSWORD in environment.");
  const input = z.object({
    email: z.email().max(254).transform(value => value.toLowerCase()),
    name: z.string().trim().min(1).max(120),
    role: z.enum(["owner", "admin", "master", "stock", "accountant", "operator"]),
    staffId: z.string().min(1).max(150).optional(),
  }).safeParse({ email: args[0].trim(), name: args[1], role: args[2], staffId: args[3] });
  if (!input.success) throw new Error("Invalid email, name, role or staffId.");
  const password = process.env.SALONIT_USER_PASSWORD;
  delete process.env.SALONIT_USER_PASSWORD;
  if (!password || password.length < 12 || password.length > 128) throw new Error("SALONIT_USER_PASSWORD must contain 12–128 characters.");
  const { email, name, role, staffId } = input.data;
  if (role === "master" && !staffId) throw new Error("A master requires an active staffId.");
  const hash = await hashPassword(password);
  await transaction(async tx => {
    if (staffId) {
      const staff = await first<{ data: { active?: boolean } }>("SELECT data FROM records WHERE kind='staff' AND id=$1 FOR SHARE", [staffId], tx);
      if (!staff?.data.active) throw new Error("staffId does not refer to an active employee.");
    }
    if (await first('SELECT id FROM auth."user" WHERE lower(email)=$1', [email], tx)) throw new Error("An account with this email already exists.");
    const id = randomUUID();
    await tx.query('INSERT INTO auth."user"(id,name,email,email_verified,role,staff_id) VALUES($1,$2,$3,false,$4,$5)', [id, name, email, role, staffId ?? null]);
    await tx.query("INSERT INTO auth.account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)", [randomUUID(), id, hash]);
  });
  console.log("Employee account created.");
}
void main().catch(error => {
  // Database errors can carry query values; do not print raw objects or credentials.
  const databaseError = error && typeof error === "object" && "code" in error;
  console.error(databaseError ? "Could not create account. Check database access and existing accounts." : error instanceof Error ? error.message : "Could not create account.");
  process.exitCode = 1;
}).finally(() => pool.end());
