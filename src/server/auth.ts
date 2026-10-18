import "dotenv/config";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";
import { db, first, pool } from "./db";
import * as schema from "./auth-schema";
import type { Actor, Role } from "@/lib/contracts";
import { AppError } from "./errors";
import { hasClientDeviceProof } from "./client-access";
export const isDemo = () => process.env.APP_MODE === "demo";
export const auth = betterAuth({
 baseURL:process.env.BETTER_AUTH_URL,
 secret:process.env.BETTER_AUTH_SECRET,
 trustedOrigins:[process.env.BETTER_AUTH_URL??"http://localhost:3000","http://127.0.0.1:3000"],
 database:drizzleAdapter(db,{provider:"pg",schema,transaction:true}),
 emailAndPassword:{enabled:true,disableSignUp:true},
 user:{additionalFields:{role:{type:"string",defaultValue:"client",input:false},staffId:{type:"string",required:false,input:false},clientId:{type:"string",required:false,input:false}}},
 session:{expiresIn:60*60*24*7,updateAge:60*60},
 rateLimit:{enabled:true,window:60,max:100},
 plugins:[phoneNumber({
  otpLength:6,expiresIn:300,
  phoneNumberValidator:(phone)=>/^\+7\d{10}$/.test(phone),
  sendOTP:async({phoneNumber:phone,code})=>{
   if(!isDemo()) throw new AppError(503,"SMS-провайдер не подключён. Настройте его перед рабочим запуском.");
   await pool.query("INSERT INTO demo_otp(phone,code,expires_at) VALUES($1,$2,now()+interval '5 minutes') ON CONFLICT(phone) DO UPDATE SET code=EXCLUDED.code,expires_at=EXCLUDED.expires_at",[phone,code]);
  },
  signUpOnVerification:{getTempEmail:phone=>phone.replace(/\D/g,"")+"@phone.salonit.invalid",getTempName:()=> "Клиент"},
 })],
});
export async function getActor(requestHeaders:Headers):Promise<Actor|null> {
 const session=await auth.api.getSession({headers:requestHeaders});
 if(!session)return null;
 const u=await first<{id:string;name:string;role:Role;staff_id:string|null;client_id:string|null;phone_number:string|null}>('SELECT id,name,role,staff_id,client_id,phone_number FROM auth."user" WHERE id=$1',[session.user.id]);
 if(!u)return null;
 if(u.role==="client"&&u.phone_number&&!await hasClientDeviceProof(u.id,u.client_id,requestHeaders))return null;
 if(u.staff_id){const member=await first<{data:{active?:boolean}}>("SELECT data FROM records WHERE kind='staff' AND id=$1",[u.staff_id]);if(!member||member.data.active===false)return null;}
 return {id:u.id,name:u.name,role:u.role,staffId:u.staff_id,clientId:u.client_id};
}

