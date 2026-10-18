import type { Actor, Role, Visit } from "@/lib/contracts";
import { AppError } from "./errors";
export function authorize(actor: Actor | null, roles: Role[]): asserts actor is Actor {
  if(!actor) throw new AppError(401,"Войдите в аккаунт","UNAUTHENTICATED");
  if(!roles.includes(actor.role)) throw new AppError(403,"Для этого действия недостаточно прав","FORBIDDEN");
}
export function canManageVisit(actor:Actor,visit:Pick<Visit,"clientId"|"items">) {
  return ["owner","admin"].includes(actor.role) || (actor.role==="master" && visit.items.some(i=>i.staffId===actor.staffId)) || (actor.role==="client"&&visit.clientId===actor.clientId);
}

