// Reproduce the detector timing: when does y<lo fire relative to peak (max y)?
// Spec runner: 180 spm => 90/foot => 1.5 Hz per foot. ankle.y = mu + A*sin(phase).
// Detector: mu tracks slow mean, amp = EMA of |y-mu|, hi=mu+0.45a, lo=mu-0.1a.
// Peak (max y) of sin is at phase=pi/2. We find when y crosses below lo AFTER that.

const fps = 60;
const fPerFoot = 1.5; // Hz
const A = 0.03;
const base = 0.86;

let mu = base, amp = 0.005, started=false, active=false, peakY=-Infinity, peakT=0;
const N = 60*12;
let firstPeakT=null, firstFireT=null;
for (let i=0;i<N;i++){
  const t=(i/fps)*1000;
  const phase = 2*Math.PI*fPerFoot*(i/fps);
  const y = base + A*Math.sin(phase);
  if(!started){ mu=y; amp=0.005; started=true; continue; }
  mu += 0.02*(y-mu);
  amp += 0.02*(Math.abs(y-mu)-amp);
  const a=Math.max(amp,0.004);
  const hi=mu+0.45*a, lo=mu-0.1*a;
  if(!active){
    if(y>hi){active=true;peakY=y;peakT=t;}
  } else {
    if(y>peakY){peakY=y;peakT=t;}
    if(y<lo){
      active=false;
      // record once we're in steady state (after a few cycles)
      if(t>4000 && firstPeakT===null){ firstPeakT=peakT; firstFireT=t; }
    }
  }
}
console.log("peakT (reported contact) =", firstPeakT, "ms");
console.log("fireT (y<lo, when geom committed) =", firstFireT, "ms");
console.log("lag =", (firstFireT-firstPeakT).toFixed(1), "ms");
console.log("step period per foot =", (1000/fPerFoot).toFixed(1), "ms; lag as fraction =", ((firstFireT-firstPeakT)/(1000/fPerFoot)).toFixed(3));
