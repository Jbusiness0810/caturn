let t=0;
function setup(){createCanvas(480,480);noStroke();}
function draw(){
background(26,20,8);
t+=0.012;
push();translate(240,240);
// back half of ring
push();rotate(-0.42);
noFill();stroke(176,138,62);strokeWeight(9);
arc(0,0,400,120,PI,2*PI);
pop();
// planet disc
let g=drawingContext.createRadialGradient(-42,-48,10,0,0,150);
g.addColorStop(0,'#fdf8ec');
g.addColorStop(0.55,'#f3ecdd');
g.addColorStop(1,'#c9bb9b');
noStroke();drawingContext.fillStyle=g;circle(0,0,248);
// subtle bands
push();clip(function(){});pop();
fill(90,69,32,42);
ellipse(0,-30,230,26);
ellipse(0,22,244,30);
ellipse(0,74,236,22);
// front arc of ring
push();rotate(-0.42);
stroke(176,138,62);strokeWeight(9);
arc(0,0,400,120,0,PI);
stroke(210,180,110);strokeWeight(3);
arc(0,0,400,120,0.15,PI-0.2);
pop();
// shading
noStroke();
let s=drawingContext.createRadialGradient(90,70,10,0,0,150);
s.addColorStop(0,'rgba(90,69,32,0)');
s.addColorStop(1,'rgba(90,69,32,0.55)');
drawingContext.fillStyle=s;circle(0,0,248);
pop();
}
