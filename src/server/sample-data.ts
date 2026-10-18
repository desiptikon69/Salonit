import type {Service,Staff,Material,Resource,Bundle,Settings} from "@/lib/contracts";
const raw:[string,string,Service["category"],number,number,string,string][]=[
["hair-women","Женская стрижка","Волосы",2000,75,"hair","hair-chair"],["hair-men","Мужская стрижка","Волосы",1200,45,"hair","hair-chair"],["hair-blowdry","Укладка на брашинг","Волосы",1800,45,"hair","hair-chair"],["hair-curls","Укладка локонами","Волосы",3000,90,"hair","hair-chair"],["hair-color","Окрашивание в один тон","Волосы",5000,120,"hair","hair-chair"],["hair-roots","Окрашивание корней","Волосы",4200,105,"hair","hair-chair"],
["nails-manicure","Маникюр без покрытия","Ногти",1600,45,"hands","nail-chair"],["nails-manicure-gel","Маникюр с гель-лаком","Ногти",2500,90,"hands","nail-chair"],["nails-pedicure","Педикюр без покрытия","Ногти",2800,60,"feet","nail-chair"],["nails-pedicure-gel","Педикюр с гель-лаком","Ногти",3500,90,"feet","nail-chair"],["nails-gel-removal","Снятие гель-лака","Ногти",600,20,"hands","nail-chair"],["nails-gel-coating","Покрытие гель-лаком","Ногти",1100,30,"hands","nail-chair"],
["brows-shape","Оформление бровей","Брови и ресницы",1000,30,"brows","beauty-chair"],["brows-color-shape","Оформление и окрашивание бровей","Брови и ресницы",1600,45,"brows","beauty-chair"],["brows-lamination","Ламинирование бровей","Брови и ресницы",2500,60,"brows","beauty-chair"],["lashes-lamination","Ламинирование ресниц","Брови и ресницы",2700,75,"brows","beauty-chair"],
["makeup-day","Дневной макияж","Макияж",3500,60,"makeup","beauty-chair"],["makeup-evening","Вечерний макияж","Макияж",4200,75,"makeup","beauty-chair"],["care-hair-mask","Экспресс-уход для волос","Уход",1300,30,"hair","hair-chair"],["care-hands","Уход для рук","Уход",800,20,"hands","nail-chair"]];
export const services:Service[]=raw.map(([id,name,category,price,durationMinutes,skill,resourceType])=>({
 id,name,category,priceMinor:price*100,durationMinutes,bufferMinutes:10,skill,resourceType,active:true,
 description:skill==="hair"?"Забота о волосах, точная форма и индивидуальный финиш.":skill==="hands"||skill==="feet"?"Аккуратная обработка и комфорт на каждом этапе.":"Выразительные детали, которые остаются естественными.",
 norms:skill==="hair"?[{materialId:id.includes("color")||id.includes("roots")?"color":"shampoo",quantityMilli:id.includes("color")?60000:id.includes("roots")?40000:15000}]:[{materialId:skill==="hands"||skill==="feet"?"nail-kit":skill==="brows"?"brow-kit":"makeup-kit",quantityMilli:1000}],
 ...(id==="hair-color"?{stages:[{name:"Нанесение",durationMinutes:35,needsStaff:true},{name:"Выдержка",durationMinutes:45,needsStaff:false},{name:"Смывание и укладка",durationMinutes:40,needsStaff:true}]}:{})
}));
export const staff:Staff[]=[
{id:"anna",name:"Анна Соколова",title:"Топ-стилист",initials:"АС",color:"#8f7869",skills:["hair"],commissionBps:4000,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true,workStart:"09:00",workEnd:"21:00"},
{id:"maria",name:"Мария Лебедева",title:"Мастер маникюра",initials:"МЛ",color:"#789687",skills:["hands"],commissionBps:4000,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true,workStart:"09:00",workEnd:"21:00"},
{id:"elena",name:"Елена Морозова",title:"Мастер педикюра",initials:"ЕМ",color:"#b69974",skills:["feet","hands"],commissionBps:4000,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true,workStart:"09:00",workEnd:"21:00"},
{id:"sofia",name:"София Волкова",title:"Бровист · визажист",initials:"СВ",color:"#958baa",skills:["brows","makeup"],commissionBps:4500,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true,workStart:"09:00",workEnd:"21:00"},
{id:"maxim",name:"Максим Орлов",title:"Стилист · колорист",initials:"МО",color:"#6d8b9f",skills:["hair"],commissionBps:4000,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true,workStart:"10:00",workEnd:"21:00"},
];
export const resources:Resource[]=[
{id:"hair-1",name:"Кресло стилиста 1",type:"hair-chair",ready:true,status:"ready"},{id:"hair-2",name:"Кресло стилиста 2",type:"hair-chair",ready:true,status:"ready"},
{id:"nail-1",name:"Кресло для комплекса 1",type:"nail-chair",ready:true,status:"ready"},{id:"nail-2",name:"Кресло для комплекса 2",type:"nail-chair",ready:true,status:"ready"},
{id:"beauty-1",name:"Место визажиста",type:"beauty-chair",ready:true,status:"ready"},
{id:"tools-hands-1",name:"Набор для маникюра 1",type:"tools-hands",ready:true,status:"ready"},{id:"tools-hands-2",name:"Набор для маникюра 2",type:"tools-hands",ready:true,status:"ready"},
{id:"tools-feet-1",name:"Набор для педикюра 1",type:"tools-feet",ready:true,status:"ready"},{id:"tools-feet-2",name:"Набор для педикюра 2",type:"tools-feet",ready:false,status:"processing"}
];
export const materials:Material[]=[
{id:"shampoo",name:"Шампунь · учебный материал",unit:"мл",stockMilli:5000000,minStockMilli:1000000,costMinor:200,supplier:"Демо Проф"},
{id:"color",name:"Смесь для окрашивания · учебная",unit:"г",stockMilli:1200000,minStockMilli:300000,costMinor:1000,supplier:"Демо Проф"},
{id:"nail-kit",name:"Одноразовый набор для ногтей",unit:"компл.",stockMilli:85000,minStockMilli:20000,costMinor:9000,supplier:"Демо Бьюти"},
{id:"brow-kit",name:"Набор для бровей",unit:"компл.",stockMilli:35000,minStockMilli:10000,costMinor:12000,supplier:"Демо Бьюти"},
{id:"makeup-kit",name:"Материалы для макияжа",unit:"порция",stockMilli:18000,minStockMilli:20000,costMinor:25000,supplier:"Демо Бьюти"}
];
export const bundles:Bundle[]=[{id:"duo",name:"Маникюр + педикюр",description:"Два мастера одновременно. Полный уход за одно посещение.",serviceIds:["nails-manicure-gel","nails-pedicure-gel"],mode:"parallel"},{id:"hair-day",name:"Новая форма и уход",description:"Стрижка и экспресс-уход последовательно.",serviceIds:["hair-women","care-hair-mask"],mode:"sequential"},{id:"complete",name:"Выразительный взгляд",description:"Оформление бровей и ламинирование ресниц.",serviceIds:["brows-color-shape","lashes-lamination"],mode:"sequential"}];
export const settings:Settings={name:"SalonIt",subtitle:"Красота, в которой удобно быть собой",address:"Демонстрационная студия · адрес настраивается",phone:"+7 (000) 000-00-00",hours:"Ежедневно, 09:00–21:00",timezone:"Europe/Moscow",currency:"RUB",mode:"demo",cancellationHours:3};

