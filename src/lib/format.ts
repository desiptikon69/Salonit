export const money=(minor:number)=>new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",maximumFractionDigits:0}).format(minor/100);
export const shortDate=(date:string)=>new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"short",timeZone:"Europe/Moscow"}).format(new Date(date));
export const time=(date:string)=>new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Moscow"}).format(new Date(date));
export const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow"}).format(new Date());

