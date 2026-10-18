import {randomUUID} from "node:crypto";
import {hashPassword} from "better-auth/crypto";
import {transaction,first} from "./db";
import {saveRecord} from "./records";
import {services,staff,resources,materials,bundles,settings} from "./sample-data";
import {planVisit} from "@/domain/scheduling";
import type {Role} from "@/lib/contracts";
export async function seedDemo(){
 if(process.env.APP_MODE!=="demo")throw new Error("Seed разрешён только в DEMO");
 if(await first("SELECT 1 FROM records WHERE id='salon-settings'"))return;
 const pass=process.env.DEMO_PASSWORD;if(!pass)throw new Error("DEMO_PASSWORD required");
 const hash=await hashPassword(pass);
 await transaction(async tx=>{
  for(const [kind,items] of [["service",services],["staff",staff],["resource",resources],["material",materials],["bundle",bundles]] as const)for(const item of items)await saveRecord(kind,item.id,item,tx);
  await saveRecord("settings","salon-settings",settings,tx);
  const names=["Алиса Белова","Полина Крылова","Дарья Васильева","Виктория Зайцева","Анастасия Смирнова","Екатерина Попова","Ирина Новикова","Александр Мельников","Наталья Козлова","Ольга Федорова","Андрей Романов","Ксения Тихонова"];
  for(let i=0;i<names.length;i++)await saveRecord("client","client-"+i,{name:names[i],phone:"+7900000"+String(i).padStart(4,"0"),email:"",notes:"Вымышленный профиль для знакомства с SalonIt",marketingConsent:i%3===0,createdAt:new Date(Date.now()-(i+2)*86400000).toISOString()},tx);
  for(const role of ["owner","admin","master","stock","accountant","operator","client"] as Role[]){
   const uid="demo-"+role;await tx.query('INSERT INTO auth."user"(id,name,email,email_verified,role,staff_id,client_id) VALUES($1,$2,$3,true,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[uid,role==="master"?"Анна Соколова":role==="client"?names[0]:{owner:"Владелец",admin:"Администратор",stock:"Закупщик",accountant:"Бухгалтер",operator:"Оператор"}[role],role+"@demo.salonit.invalid",role,role==="master"?"anna":null,role==="client"?"client-0":null]);
   await tx.query("INSERT INTO auth.account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3) ON CONFLICT(id) DO NOTHING",["credential-"+role,uid,hash]);
  }
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow"}).format(new Date());
  let sequence=1001;
  for(let offset=-9;offset<=3;offset++){
   const date=new Date(today+"T12:00:00+03:00");date.setUTCDate(date.getUTCDate()+offset);const day=date.toISOString().slice(0,10);
   for(let n=0;n<3;n++){
    const service=services[[0,7,13][n]],startAt=day+"T"+String(10+n*3).padStart(2,"0")+":00:00+03:00";
    const plan=planVisit({services:[service],staff,resources,startAt,mode:"sequential",busy:[]});if(!plan)continue;
    const id=randomUUID(),clientId="client-"+((offset+12+n)%names.length),closed=offset<0;
    const visitItems=plan.items.map(i=>({...i,status:closed?"completed":"planned"}));
    await tx.query("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor,paid_minor,closed_at,materials) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,"SI-"+sequence++,clientId,closed?"completed":"confirmed",plan.startAt,plan.endAt,JSON.stringify(visitItems),plan.totalMinor,closed?plan.totalMinor:0,closed?plan.endAt:null,JSON.stringify(service.norms)]);
    for(const a of plan.allocations)await tx.query("INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at,active) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),id,a.resourceKey,a.startAt,a.endAt,!closed]);
    if(closed){
     await tx.query("INSERT INTO payments(id,visit_id,method,amount_minor,kind,created_at) VALUES($1,$2,'card',$3,'payment',$4)",[randomUUID(),id,plan.totalMinor,plan.endAt]);
     for(const i of visitItems)await tx.query("INSERT INTO accruals(id,visit_id,staff_id,service_name,base_minor,amount_minor,rate_bps,status,date,rule_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9)",[randomUUID(),id,i.staffId,i.serviceName,i.priceMinor,Math.round(i.priceMinor*i.commissionBps/10000),i.commissionBps,day,JSON.stringify({commissionBps:i.commissionBps,materialsDeducted:false})]);
     for(const u of service.norms){const m=materials.find(m=>m.id===u.materialId)!;await tx.query("INSERT INTO consumptions(id,visit_id,material_id,quantity_milli,cost_minor,created_at) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),id,m.id,u.quantityMilli,Math.round(m.costMinor*u.quantityMilli/1000),plan.endAt]);}
    }
   }
  }
  await saveRecord("expense","rent",{name:"Аренда студии",category:"Аренда",amountMinor:8500000,date:today.slice(0,8)+"01",paid:true},tx);
  await saveRecord("expense","supplies",{name:"Материалы и расходники",category:"Материалы",amountMinor:1800000,date:today,paid:true},tx);
  await saveRecord("expense","utilities",{name:"Коммунальные услуги",category:"Эксплуатация",amountMinor:780000,date:today,paid:false},tx);
  await saveRecord("certificate","cert-demo",{code:"SALONIT-5000",clientId:"client-0",nominalMinor:500000,saleMinor:450000,balanceMinor:500000,liabilityMinor:450000,status:"active",kind:"certificate"},tx);
  await saveRecord("task","task-stock",{name:"Заказать материалы для макияжа",assignee:"Закупщик",dueDate:today,priority:"high",status:"open"},tx);
  await saveRecord("task","task-review",{name:"Проверить готовность инструментов",assignee:"Администратор",dueDate:today,priority:"normal",status:"open"},tx);
  await saveRecord("purchase","purchase-demo",{name:"Пополнение материалов",supplier:"Демо Бьюти",materialId:"makeup-kit",quantityMilli:10000,amountMinor:250000,status:"ordered"},tx);
  await saveRecord("installation","installation-demo",{name:"SalonIt · общий экземпляр",domain:"Локальная демонстрация",codeVersion:"0.1.0",dbVersion:"0001",status:"demo",region:"Локальная среда"},tx);
  for(const member of staff)await saveRecord("shift","shift-"+member.id,{name:member.name,staffId:member.id,date:today,start:member.workStart,end:member.workEnd,status:"planned"},tx);
  await saveRecord("notification","notice-demo",{name:"Напоминание о визите",recipient:"Алиса Белова",channel:"demo",purpose:"service",status:"simulated",date:today},tx);
 });
}
export async function resetDemo(){if(process.env.APP_MODE!=="demo"||!process.env.DATABASE_URL?.includes("salonit"))throw new Error("Reset запрещен вне SalonIt DEMO");await transaction(async tx=>{await tx.query("TRUNCATE records,appointments,allocations,payments,consumptions,accruals,payouts,audit_events,outbox,commands,import_runs,demo_otp,request_limits CASCADE");await tx.query('DELETE FROM auth.session');await tx.query('DELETE FROM auth.account');await tx.query('DELETE FROM auth."user"');await tx.query("DELETE FROM auth.verification");});await seedDemo();}


