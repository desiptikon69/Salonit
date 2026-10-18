import { z } from "zod";
export const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const text = z.string().trim().min(1).max(2000);
export const id = z.string().min(1).max(200);
export const usage = z.object({ materialId:id, quantityMilli:money });
export const visitId = z.object({ id:z.string().uuid(),version:z.number().int().positive().optional() });
export const resourceProcess = z.object({ id, event:z.enum(["used","start","cleaned","sterilized","control_pass","control_fail"]) });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const schemas = {
  service:z.object({id:id.optional(),name:text,category:z.enum(["Волосы","Ногти","Брови и ресницы","Макияж","Уход"]),description:z.string().max(5000).default(""),durationMinutes:z.number().int().min(5).max(720),bufferMinutes:z.number().int().min(0).max(120).default(0),priceMinor:money,skill:text,resourceType:text,active:z.boolean().default(true),norms:z.array(usage).max(100).default([]),stages:z.array(z.object({name:text,durationMinutes:z.number().int().positive(),needsStaff:z.boolean()})).optional()}),
  staff:z.object({id:id.optional(),name:text,title:text,initials:z.string().max(5),color:z.string().max(50),skills:z.array(text).min(1),commissionBps:z.number().int().min(0).max(10000),fixedMinor:money,guaranteeMinor:money,guaranteeScope:z.enum(["total","variable"]),active:z.boolean(),workStart:time,workEnd:time}),
  resource:z.object({id:id.optional(),name:text,type:text,ready:z.boolean(),status:text,processingValidityHours:z.number().int().min(1).max(720).optional()}),
  client:z.object({id:id.optional(),name:text,phone:z.string().regex(/^\+?\d[\d ()-]{8,20}$/),email:z.union([z.string().email(),z.literal("")]).default(""),notes:z.string().max(10000).default(""),marketingConsent:z.boolean().default(false)}),
  material:z.object({id:id.optional(),name:text,unit:text,stockMilli:money.default(0),minStockMilli:money,costMinor:money,supplier:z.string().max(2000).default("")}),
  expense:z.object({id:id.optional(),name:text,category:text,amountMinor:money,date,paid:z.boolean()}),
  task:z.object({id:id.optional(),name:text,assignee:text,dueDate:date,priority:z.enum(["low","normal","high","urgent"]),status:z.enum(["open","in_progress","done","cancelled"])}),
  complaint:z.object({id:id.optional(),name:text,clientId:id,visitId:z.string().uuid(),reason:text,assignee:text,status:z.enum(["open","in_progress","resolved","closed"]),dueDate:date,resolution:z.string().max(10000).optional()}),
  purchase:z.object({id:id.optional(),name:text,supplier:text,materialId:id,quantityMilli:money.refine(n=>n>0),amountMinor:money,status:z.enum(["draft","ordered","cancelled"])}),
  shift:z.object({id:id.optional(),name:text,staffId:id,date,start:time,end:time,status:z.enum(["planned","active","completed","cancelled"])}),
  installation:z.object({id:id.optional(),name:text,domain:z.string().max(253),codeVersion:text,dbVersion:text,status:z.enum(["test","paused","active","maintenance","offline","ready"]),region:text}),
  settings:z.object({name:text,subtitle:z.string().max(2000).optional(),address:text,phone:text,hours:text,timezone:z.string().refine(v=>{try {new Intl.DateTimeFormat("en",{timeZone:v});return true;}catch{return false;}}).optional(),currency:z.literal("RUB").optional()})
};
