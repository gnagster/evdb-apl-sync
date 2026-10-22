'use strict';
(function (global) {
  const fields = [
    ['years','Haltedauer','Jahre',null,1,30], ['annualKm','Jährliche Fahrleistung','km',null,1,200000],
    ['resale','Restwert am Ende (Schätzung)','€',null,0,1000000],
    ['homePrice','Strompreis zu Hause','€/kWh',null,0,5], ['publicPrice','Strompreis öffentlich','€/kWh',null,0,5],
    ['homeSharePercent','Anteil Laden zu Hause','%',80,0,100], ['lossPercent','Ladeverluste vom Netzbezug','%',10,0,50],
    ['insurance','Versicherung pro Jahr','€',null,0,100000], ['tax','Kfz-Steuer pro Jahr','€',null,0,10000],
    ['maintenance','Wartung und Reparaturen pro Jahr','€',null,0,100000], ['tyres','Reifen pro Jahr','€',null,0,100000],
    ['otherAnnual','Weitere Kosten pro Jahr','€',0,0,100000], ['thg','THG-Erlös pro Jahr (Schätzung)','€',null,0,10000],
    ['grant','Einmaliger Zuschuss (nur falls berechtigt)','€',0,0,1000000], ['purchaseFees','Zusätzliche Anschaffungskosten','€',0,0,100000],
    ['downPayment','Anzahlung bei Finanzierung','€',null,0,1000000], ['loanMonths','Kreditlaufzeit','Monate',60,1,600],
    ['interestPercent','Jährlicher Sollzins','%',null,0,50], ['balloon','Schlussrate','€',0,0,1000000], ['loanFees','Finanzierungsgebühren','€',0,0,100000]
  ];
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Ungültige TCO-Eingaben.');
    if (input.financed != null && typeof input.financed !== 'boolean') throw Error('Ungültige Finanzierungsart.');
    for (const [key,label,,defaultValue,min,max] of fields) {
      const value = input[key] ?? defaultValue;
      if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) throw Error('Ungültiger Wert: ' + label);
    }
    if (input.loanMonths != null && !Number.isInteger(input.loanMonths)) throw Error('Kreditlaufzeit muss ganze Monate enthalten.');
    return input;
  }
  function calculate(vehicle, input) {
    validate(input);
    const v = Object.fromEntries(fields.map(([key,,,def]) => [key,input[key] ?? def]));
    const missing = [], items = [];
    const need = (key) => { if (v[key] == null) missing.push(fields.find(f=>f[0]===key)[1]);return v[key]; };
    const years = need('years'), km = need('annualKm');
    const price = vehicle.priceEur, consumption = vehicle.efficiencyWhKm;
    if (!Number.isFinite(price) || price <= 0) missing.push('Fahrzeugpreis');
    if (!Number.isFinite(consumption) || consumption <= 0) missing.push('EVDB-Verbrauch');
    const resale = need('resale'), share = v.homeSharePercent / 100;
    if (share > 0) need('homePrice');if (share < 1) need('publicPrice');
    const energyRate = (v.homePrice ?? 0)*share + (v.publicPrice ?? 0)*(1-share);
    const energyKwh = km && consumption > 0 ? km * consumption / 1000 / (1-v.lossPercent/100) : null;
    const add = (label,value) => items.push({label,value:Number.isFinite(value) ? Math.round(value*100)/100 : null});
    add('Wertverlust und Anschaffung', price > 0 && years && resale != null ? price + v.purchaseFees - resale - v.grant : null);
    add('Strom', years && energyKwh != null && !(share>0 && v.homePrice==null) && !(share<1 && v.publicPrice==null) ? years*energyKwh*energyRate : null);
    for (const key of ['insurance','tax','maintenance','tyres','otherAnnual','thg']) {
      need(key);add(fields.find(f=>f[0]===key)[1],years && v[key]!=null ? years*v[key]*(key==='thg'?-1:1) : null);
    }
    let monthlyPayment = 0, remainingDebt = 0, interest = 0;
    if (input.financed) {
      need('downPayment');need('interestPercent');
      if (price > 0 && v.downPayment != null && v.interestPercent != null && years) {
        const principal = price-v.downPayment, r=v.interestPercent/1200, n=v.loanMonths;
        if (principal<0 || v.balloon>principal) throw Error('Anzahlung oder Schlussrate übersteigt den finanzierten Betrag.');
        monthlyPayment = principal === 0 ? 0 : r===0 ? (principal-v.balloon)/n : (principal-v.balloon/(1+r)**n)*r/(1-(1+r)**-n);
        remainingDebt=principal;
        for(let m=0;m<Math.min(n,Math.round(years*12));m++) { const part=remainingDebt*r;interest+=part;remainingDebt=Math.max(0,remainingDebt+part-monthlyPayment); }
        if (years*12>=n) remainingDebt=0; // The balloon is principal repayment, not an additional TCO cost.
        add('Finanzierungszinsen und Gebühren',interest+v.loanFees);
      } else add('Finanzierungszinsen und Gebühren',null);
    }
    const partialTotal=Math.round(items.reduce((sum,item)=>sum+(item.value??0),0)*100)/100;
    const total=missing.length || items.some(i=>i.value==null) ? null : partialTotal;
    return {total,partialTotal,monthly:total==null?null:total/(years*12),perKm:total==null?null:total/(years*km),items,missing:[...new Set(missing)],inputs:{...v,financed:!!input.financed},annualEnergyKwh:energyKwh,monthlyPayment,remainingDebt,interest,years,annualKm:km,priceEur:price,rangeKm:vehicle.rangeKm,stopRangeKm:vehicle.stopRangeKm};
  }
  const api={fields,validate,calculate};global.EVTCO=api;
  if(typeof module!=='undefined' && module.exports) module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
