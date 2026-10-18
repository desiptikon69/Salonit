import {z} from "zod";
import {auth,getActor} from "./auth";
import {AppError} from "./errors";
import {first} from "./db";
import type {Actor} from "@/lib/contracts";
export const phoneSchema=z.string().transform(s=>{const digits=s.replace(/\D/g,"");return "+"+(digits.length===11&&digits[0]==="8"?"7"+digits.slice(1):digits);}).pipe(z.string().regex(/^\+7\d{10}$/, "Укажите телефон в формате +7 и 10 цифр"));
export async function actorFor(req:Request):Promise<Actor>{const actor=await getActor(req.headers);if(!actor)throw new AppError(401,"Войдите в систему","UNAUTHORIZED");return actor;}
export function sameOrigin(req:Request){const origin=req.headers.get("origin");const allowed=[new URL(req.url).origin,process.env.BETTER_AUTH_URL,...(process.env.APP_MODE==="demo"?["http://127.0.0.1:3000","http://localhost:3000"]:[])];if(!origin||!allowed.includes(origin))throw new AppError(403,"Запрос с другого сайта отклонён");}
export async function bodyFor(req:Request){sameOrigin(req);if(!req.headers.get("content-type")?.includes("application/json"))throw new AppError(415,"Ожидается JSON");const text=await req.text();if(text.length>1_000_000)throw new AppError(413,"Слишком большой запрос");try{return JSON.parse(text);}catch{throw new AppError(400,"Некорректный JSON");}}
export function json(value:unknown,status=200,headers?:Headers){const h=new Headers(headers);h.set("Cache-Control","no-store");return Response.json(value,{status,headers:h});}
export function route(fn:(req:Request)=>Promise<Response>){return async(req:Request)=>{try{return await fn(req);}catch(error){if(error instanceof z.ZodError)return json({error:error.issues.map(i=>i.message).join("; ")},400);if(error instanceof AppError)return json({error:error.message,code:error.code},error.status);if(error&&typeof error==="object"&&"statusCode"in error){const e=error as {statusCode:number;body?:{message?:string}};return json({error:e.body?.message??"Ошибка авторизации"},e.statusCode);}console.error("API error",error);return json({error:"Не удалось выполнить действие. Повторите попытку."},500);}};}
export async function rateLimit(key:string,max=8,seconds=60){const r=await first<{count:number}>("INSERT INTO request_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN request_limits.expires_at<now() THEN 1 ELSE request_limits.count+1 END,expires_at=CASE WHEN request_limits.expires_at<now() THEN now()+$2*interval '1 second' ELSE request_limits.expires_at END RETURNING count",[key,seconds]);if((r?.count??0)>max)throw new AppError(429,"Слишком много попыток. Попробуйте позже.");}
// Only for a successful internal phone verification, before issuing device proof.
// General request authentication must always use getActor/actorFor.
export async function sessionFromResponse(response:Response,verifiedPhone:string):Promise<Actor>{
 if(!response.ok)throw new AppError(401,"Не удалось создать сессию");
 const headers=new Headers();headers.set("cookie",response.headers.getSetCookie().map(v=>v.split(";")[0]).join("; "));
 const session=await auth.api.getSession({headers});
 const user=session?await first<{id:string;name:string;role:"client";client_id:string|null;phone_number:string;phone_number_verified:boolean}>('SELECT id,name,role,client_id,phone_number,phone_number_verified FROM auth."user" WHERE id=$1',[session.user.id]):undefined;
 if(!user||user.role!=="client"||!user.phone_number_verified||user.phone_number!==verifiedPhone)throw new AppError(401,"Не удалось подтвердить клиентскую сессию");
 return {id:user.id,name:user.name,role:user.role,clientId:user.client_id};
}
export async function verifyOtp(req:Request,phone:string,code:string){return auth.api.verifyPhoneNumber({body:{phoneNumber:phone,code},headers:req.headers,asResponse:true});}


