// Caturn — cream marble planet, antique-gold ring
// p5.js, no libraries, no assets

const CREAM = [243, 236, 221];
const BRASS = [176, 138, 62];
const UMBER = [90, 69, 32];

let t = 0;

function setup() {
  createCanvas(480, 480);
  noStroke();
}

function draw() {
  background(UMBER);
  t += 0.012;

  const cx = width / 2, cy = height / 2;

  // back half of the ring
  push();
  translate(cx, cy);
  rotate(-0.42);
  noFill();
  stroke(BRASS[0], BRASS[1], BRASS[2], 190);
  strokeWeight(7);
  ellipse(0, 0, 360, 96);
  pop();

  // planet body
  push();
  translate(cx, cy);
  const r = 110;
  for (let i = r; i > 0; i--) {
    const k = i / r;
    const c = lerpColor(color(CREAM[0] - 26, CREAM[1] - 34, CREAM[2] - 40), color(...CREAM), k);
    fill(c);
    ellipse(0, 0, i * 2, i * 2);
  }

  // slow marble veining, clipped to the disc
  const g = createGraphics(r * 2, r * 2);
  g.noStroke();
  for (let v = 0; v < 7; v++) {
    g.fill(176, 138, 62, 26);
    g.beginShape();
    for (let a = 0; a < TWO_PI; a += 0.35) {
      const w = 26 + 16 * sin(a * 3 + v * 1.7 + t);
      g.vertex(r + cos(a) * (v * 12 - 34) + cos(a + 1.2) * w, r + sin(a) * (v * 9 - 24) + sin(a + 1.2) * w);
    }
    g.endShape(CLOSE);
  }
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.arc(0, 0, r, 0, TWO_PI);
  drawingContext.clip();
  imageMode(CENTER);
  image(g, 0, 0);
  drawingContext.restore();
  pop();

  // front half of the ring
  push();
  translate(cx, cy);
  rotate(-0.42);
  noFill();
  stroke(BRASS[0], BRASS[1], BRASS[2], 230);
  strokeWeight(7);
  arc(0, 0, 360, 96, 0, PI); // front half of the ring, over the planet
  pop();
}
