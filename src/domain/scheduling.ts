import { randomUUID } from "node:crypto";
import type { Service, Staff, Resource, VisitItem } from "@/lib/contracts";
export interface Allocation { resourceKey: string; startAt: string; endAt: string; }
export interface Plan { items: VisitItem[]; allocations: Allocation[]; startAt: string; endAt: string; totalMinor: number; }
export const overlaps = (a: number, b: number, c: number, d: number) => a < d && c < b;
const ms = (s: string) => new Date(s).getTime();
const iso = (n: number) => new Date(n).toISOString();
const minute = 60000;
const localDay = (time: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(time);
function localMinutes(time: number) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time);
  const [h, m] = p.split(":").map(Number); return h * 60 + m;
}
const clock = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
// Legacy demo instruments have no expiry until their first recorded processing cycle.
// Future bookings use readiness now; execution must check the current cycle again.
export const resourceReady = (resource: Resource, now = Date.now()) => resource.ready && resource.status === "ready" && (!resource.readyUntil || Date.parse(resource.readyUntil) > now);
export function planVisit(input: { services: Service[]; staff: Staff[]; resources: Resource[]; startAt: string; mode: "parallel" | "sequential"; busy: Allocation[]; staffId?: string }): Plan | null {
  const { services, resources, busy, mode } = input, start = ms(input.startAt);
  if (!Number.isFinite(start) || !services.length || services.length > 6 || new Set(services.map(s => s.id)).size !== services.length) return null;
  if (services.some(s => !s.active || !Number.isFinite(s.durationMinutes) || !Number.isFinite(s.bufferMinutes) || s.durationMinutes <= 0 || s.bufferMinutes < 0)) return null;
  if (mode === "parallel" && (services.length !== 2 || new Set(services.map(s => s.skill)).size !== 2 || !services.every(s => ["hands", "feet"].includes(s.skill)))) return null;
  if (services.some(s => s.id === "nails-manicure-gel") && services.some(s => s.id === "nails-gel-coating")) return null;
  const preferred = input.staff.find(s => s.id === input.staffId && s.active);
  const preferredIndex = services.findIndex(s => preferred?.skills.includes(s.skill));
  if (input.staffId && preferredIndex < 0) return null;
  let cursor = start;
  const timings = services.map(service => {
    const a = mode === "parallel" ? start : cursor, b = a + service.durationMinutes * minute, e = b + service.bufferMinutes * minute;
    cursor = e;
    const stages = service.stages?.length ? service.stages : [{ name: service.name, durationMinutes: service.durationMinutes, needsStaff: true }];
    let offset = a;
    const active: { a: number; b: number }[] = [];
    for (const stage of stages) {
      if (stage.needsStaff) active.push({ a: offset, b: offset + stage.durationMinutes * minute });
      offset += stage.durationMinutes * minute;
    }
    if (active.length) active[active.length - 1].b += service.bufferMinutes * minute;
    return { a, b, e, active, valid: stages.every(s => Number.isFinite(s.durationMinutes) && s.durationMinutes > 0) && offset === b && active.length > 0 && localDay(a) === localDay(e) };
  });
  if (timings.some(t => !t.valid)) return null;
  const free = (allocations: Allocation[], key: string, a: number, b: number) => ![...busy, ...allocations].some(x => x.resourceKey === key && overlaps(a, b, ms(x.startAt), ms(x.endAt)));
  const allocation = (resourceKey: string, a: number, b: number): Allocation => ({ resourceKey, startAt: iso(a), endAt: iso(b) });
  // Search depth is bounded by six services (parallel visits have exactly two).
  // Each branch owns its allocations, so a failed candidate never poisons the next one.
  function assign(index: number, allocations: Allocation[], items: VisitItem[], sharedChair?: string): Plan | null {
    if (index === services.length) return { items, allocations, startAt: iso(start), endAt: iso(Math.max(...timings.map(t => t.b))), totalMinor: items.reduce((n, i) => n + i.priceMinor, 0) };
    const service = services[index], { a, b, e, active } = timings[index];
    // A chosen specialist participates in one parallel procedure; companions are automatic.
    const pinPreferred = preferred && (mode === "parallel" ? index === preferredIndex : preferred.skills.includes(service.skill));
    const members = input.staff.filter(s => s.active && s.skills.includes(service.skill) && (!pinPreferred || s.id === preferred.id) && localMinutes(a) >= clock(s.workStart) && localMinutes(e) <= clock(s.workEnd) && active.every(t => free(allocations, "staff:" + s.id, t.a, t.b)));
    for (const member of members) {
      const staffed = [...allocations, ...active.map(t => allocation("staff:" + member.id, t.a, t.b))];
      // Reserve the shared chair for the entire parallel visit from the outset.
      const chairEnd = mode === "parallel" ? Math.max(...timings.map(t => t.e)) : e;
      const chairs = resources.filter(r => r.type === service.resourceType && resourceReady(r) && (sharedChair ? r.id === sharedChair : free(staffed, "resource:" + r.id, a, chairEnd)));
      for (const chair of chairs) {
        const seated = sharedChair ? staffed : [...staffed, allocation("resource:" + chair.id, a, chairEnd)];
        const needsTool = ["hands", "feet"].includes(service.skill);
        const tools: (Resource | undefined)[] = needsTool ? resources.filter(r => r.type === "tools-" + service.skill && resourceReady(r) && free(seated, "resource:" + r.id, a, e)) : [undefined];
        for (const tool of tools) {
          const next = tool ? [...seated, allocation("resource:" + tool.id, a, e)] : seated;
          const item: VisitItem = { id: randomUUID(), serviceId: service.id, serviceName: service.name, staffId: member.id, staffName: member.name, startAt: iso(a), endAt: iso(b), priceMinor: service.priceMinor, commissionBps: member.commissionBps, norms: service.norms, reservations: [...active.map(t => allocation("staff:" + member.id, t.a, t.b)), allocation("resource:" + chair.id, a, e), ...(tool ? [allocation("resource:" + tool.id, a, e)] : [])], status: "planned" };
          const result = assign(index + 1, next, [...items, item], mode === "parallel" ? chair.id : undefined);
          if (result) return result;
        }
      }
    }
    return null;
  }
  return assign(0, [], []);
}
