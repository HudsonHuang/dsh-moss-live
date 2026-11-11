/** Procedural voice-orb renderer with four materials and a CSS fallback. */
const VERTEX = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;
const FRAGMENT = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform float uEnergy;
uniform float uPulse;
uniform float uActivity;
uniform float uTheme;
uniform vec2 uModes;
// Every animation phase that a state can speed up or slow down arrives here
// already integrated (see update()).  Recomputing one as time * f(state) makes
// the whole phase history jump the instant f moves, by an amount that grows
// with uptime; that was the orb's sudden shaking.
uniform vec3 uDrift;
uniform float uSpin;
uniform float uBreath;
// State weights (idle, listening, thinking, speaking), eased on the CPU.
uniform vec4 uState;
// Outline morph: phases of the 2..4-lobe harmonics, integrated on the CPU at a
// voice-driven rate, the slow thinking breath (an angle), and the depth.
uniform vec4 uMorph;
uniform float uMorphAmp;
uniform float uScale;
// Soft-body squash (x, y radii multipliers) and the interior slosh (lift of
// the cloud horizon, tilt across it), all from springs on the CPU.
uniform vec2 uSquash;
uniform vec2 uSlosh;
// The canvas overhangs the orb so a deformed outline is never clipped; body
// coordinates keep the old outline near .94.
const float FRAME = 1.50;
float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}
float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
                   mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                   mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
    float value = 0.0, amplitude = 0.54;
    for (int i=0; i<4; i++) {
        value += amplitude * noise(p);
        p = p * 2.03 + vec3(4.1, 7.7, 1.9);
        amplitude *= 0.48;
    }
    return value;
}
void main() {
    vec2 uv = (gl_FragCoord.xy / uResolution - 0.5) * 2.0 * FRAME;
    float t = uTime * 0.20;
    float idle = uState.x, listening = uState.y;
    // Rest is a true circle; interaction gently introduces and releases deformation.
    float angle = atan(uv.y, uv.x);
    float speaking = uModes.x, thinking = uModes.y;
    float breath = mix(.018, .028, speaking) * sin(uBreath);
    float lobes = .043 * sin(3.0 * angle + uSpin + uTheme * .7)
        + .023 * cos(2.0 * angle - t * .7);
    // Like a soft body, not a blob: the outline stays a smooth ellipse whose
    // size pumps with the voice on a spring (uScale) and which squashes and
    // stretches (uSquash).  Only a whisper of low harmonics keeps it organic.
    float morph = .55 * sin(2.0 * angle + uMorph.x)
        + .30 * sin(3.0 * angle - uMorph.y)
        + .10 * sin(4.0 * angle + uMorph.z);
    float silhouette = .90 * uScale + uMorphAmp * morph
        + idle * .010 * sin(uBreath * .5);
    float radius = length(uv / uSquash);
    float alpha = 1.0 - smoothstep(silhouette - .008, silhouette + .007, radius);
    if (alpha <= 0.0) { gl_FragColor = vec4(0.0); return; }


    // One broad cloud bank. Noise only feathers the boundary; no domain warp,
    // thin contours, rotating surface or high-frequency detail.
    float cloudNoise = fbm(vec3(uv * 2.7 + vec2(t * .12, -t * .07), t * .08));
    float horizon = -.10 + (1.0 + .8 * uActivity) * (.12 * sin(uv.x * 2.1 + uDrift.x)
        + .055 * sin(uv.x * 3.6 - uDrift.y) + .05 * sin(uDrift.z));
    horizon += (cloudNoise - .5) * .32;
    horizon -= uEnergy * .20;
    horizon -= uPulse * .05;
    // The liquid inside sloshes with the voice: the bank rises on each
    // syllable and tilts as the body squashes.
    horizon -= uSlosh.x;
    horizon += uSlosh.y * uv.x;
    horizon += speaking * .14 * sin(t * 3.0 - uv.x * 2.0);
    horizon += thinking * .13 * sin(t * 1.8 + uv.x);
    float pigment = smoothstep(-.24, .24, uv.y - horizon);
    vec3 tint, paper;
    if (uTheme < .5) {
        tint = vec3(.39, .69, .66);
        paper = vec3(.92, .96, .91);
    } else if (uTheme < 1.5) {
        tint = vec3(.43, .61, .88);
        paper = vec3(.92, .95, .99);
    } else if (uTheme < 2.5) {
        tint = vec3(.88, .66, .54);
        paper = vec3(.99, .95, .90);
    } else {
        tint = vec3(.66, .61, .85);
        paper = vec3(.96, .94, .99);
    }
    // Soft daylight across large areas; keep the white region open and calm.
    float daylight = .10 + .13 * smoothstep(-.6, .8, -uv.x + uv.y * .3);
    tint = mix(tint, paper, daylight + uEnergy * .025);
    vec3 color = mix(paper, tint, pigment * .96);
    float veil = exp(-pow((uv.y - horizon + .18) / .26, 2.0));
    color = mix(color, vec3(.99, .995, .99), veil * .16);
    gl_FragColor = vec4(color, alpha);
}
`;

const TAU = Math.PI * 2;
/** Resting size per state, used when motion is reduced. */
function targetScaleFor(state) { return state==='speaking' ? 1 : state==='listening' ? .96 : state==='processing' ? .94 : .90; }
/** Keep an accumulated phase small so sin() never loses float precision. */
function wrap(phase) { return phase - Math.floor(phase / TAU) * TAU; }

/**
 * Create one GPU renderer. Unavailable/lost contexts leave the CSS material visible.
 * @param {HTMLCanvasElement} canvas The canvas inside the orb.
 * @returns {{update: Function, dispose: Function}} A renderer driven by the page's animation loop.
 */
export function createOrbRenderer(canvas) {
    const core = canvas.parentElement;
    const gl = canvas.getContext('webgl', {alpha:true, antialias:false, depth:false, stencil:false, powerPreference:'low-power', premultipliedAlpha:false});
    if (!gl) return { update() {}, dispose() {} };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let program, buffer, uniforms, ready = false;
    let time = 0, lastTick = 0, lastDraw = 0, energy = 0, pulse = 0, activity = 0, speed = 1, lastKey = '';
    let width = 0, pixelRatio = 1, speaking = 0, thinking = 0;
    let driftA = 0, driftB = 0, driftC = 0, spin = 0, breath = 0;
    let idleW = 1, listening = 0, scale = .92, scaleV = 0, squash = 0, squashV = 0, slosh = 0, morphAmp = 0;
    const morph = [0, 1.7, 3.1, 0];
    let pendingWidth = -1; // -1 = nothing deferred; 0 is a real (hidden) width
    const themes = {moss:0, azure:1, ember:2, aurora:3};
    function shader(type, source) {
        const result = gl.createShader(type);
        gl.shaderSource(result,source); gl.compileShader(result);
        if (!gl.getShaderParameter(result,gl.COMPILE_STATUS)) {
            console.warn('Orb shader unavailable:',gl.getShaderInfoLog(result));
            gl.deleteShader(result); return null;
        }
        return result;
    }
    function initialize() {
        const vertex = shader(gl.VERTEX_SHADER,VERTEX);
        const fragment = shader(gl.FRAGMENT_SHADER,FRAGMENT);
        if (!vertex || !fragment) return;
        program = gl.createProgram(); gl.attachShader(program,vertex); gl.attachShader(program,fragment); gl.linkProgram(program);
        gl.deleteShader(vertex); gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program,gl.LINK_STATUS)) { gl.deleteProgram(program); return; }
        gl.useProgram(program);
        buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program,'aPosition');
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        uniforms = Object.fromEntries(['uResolution','uTime','uEnergy','uPulse','uActivity','uTheme','uModes','uDrift','uSpin','uBreath','uState','uScale','uMorph','uMorphAmp','uSquash','uSlosh']
            .map(name=>[name,gl.getUniformLocation(program,name)]));
        ready = true; lastKey = ''; core.classList.add('has-orb-renderer');
    }
    /** The orb's flight to the dock is a transform, but its landing is a real
     *  layout change; resizing the canvas clears it, so hold that off until the
     *  flight is over instead of clearing a frame mid-flight. */
    function flying() { return !!canvas.closest('.orb.is-flying'); }
    function applyWidth(next) {
        width = next;
        pixelRatio = Math.min(devicePixelRatio || 1, 1.5);
        lastKey = '';
    }
    const observer = new ResizeObserver(entries => {
        const next = entries[0].contentRect.width;
        // Only the landing (a shrink) is deferred: resizing the backing store
        // clears the canvas, which would show as a blank frame mid-flight. The
        // return flight grows the orb first and then flies, so growing while
        // flying must apply at once or the whole flight renders blurred.
        if (flying() && next < width) { pendingWidth = next; return; }
        pendingWidth = -1;
        applyWidth(next);
    });
    observer.observe(canvas);
    function lost(event) { event.preventDefault(); ready=false; core.classList.remove('has-orb-renderer'); }
    canvas.addEventListener('webglcontextlost',lost);
    canvas.addEventListener('webglcontextrestored',initialize);
    initialize();
    return {
        /** Advance the material continuously and smoothly follow actual audio energy. */
        update(level, state, theme, now = performance.now()) {
            if (!ready || !width || document.hidden) { lastTick = now; return; }
            if (pendingWidth >= 0 && !flying()) { applyWidth(pendingWidth); pendingWidth = -1; }
            const dt = lastTick ? Math.min((now-lastTick)/1000,.08) : 0;
            lastTick=now;
            const targetSpeed = state==='speaking' ? 1.35 : state==='processing' ? 1.2 : state==='listening' ? 1.2 : .85;
            speed += (targetSpeed-speed)*(1-Math.exp(-dt*1.6));
            const targetEnergy = Math.max(0,Math.min(level,1));
            // Two envelopes from the same level: the fast one is syllables and
            // only lights the interior, the slow one is the phrase and is what
            // the outline follows.
            pulse += (targetEnergy-pulse)*(1-Math.exp(-dt/(targetEnergy>pulse ? .06 : .18)));
            energy += (pulse-energy)*(1-Math.exp(-dt/(pulse>energy ? .20 : .42)));
            // State weights ease over ~250 ms: quick enough that a change of
            // state reads at once, slow enough not to snap.
            const ease = 1-Math.exp(-dt*4.0);
            speaking += ((state==='speaking' ? 1 : 0)-speaking)*ease;
            thinking += ((state==='processing' ? 1 : 0)-thinking)*ease;
            listening += ((state==='listening' ? 1 : 0)-listening)*ease;
            idleW += ((state==='speaking'||state==='processing'||state==='listening' ? 0 : 1)-idleW)*ease;
            // Size pumps with the voice on an underdamped spring (ζ≈0.45), so a
            // syllable swells the orb and it settles with a soft rebound.  The
            // GPT orb's size swings about ±10%; this matches that at full voice.
            const think = .5 + .5*Math.sin(morph[3]);
            const targetScale = state==='speaking' ? .98 + .17*pulse + .05*energy
                : state==='listening' ? .95 + .10*pulse
                : state==='processing' ? .93 + .05*think : .90;
            if (dt > 0) {
                scaleV += (170*(targetScale-scale) - 11.5*scaleV)*dt;
                scale += scaleV*dt;
                // Squash: a syllable onset (fast envelope above slow) widens the
                // body and flattens it; a second, softer spring wobbles it back.
                const onset = Math.max(-.2, Math.min(.4, pulse-energy));
                const targetSquash = speaking*.16*onset + listening*.10*onset
                    + thinking*.025*Math.sin(morph[3]*.5);
                squashV += (95*(targetSquash-squash) - 7.5*squashV)*dt;
                squash += squashV*dt;
                const targetSlosh = speaking*(.30*pulse + .08*energy) + listening*.18*pulse
                    + thinking*.06*think;
                slosh += (targetSlosh-slosh)*(1-Math.exp(-dt/.09));
            }
            // A trace of outline harmonics keeps the ellipse alive.
            const targetMorph = state==='speaking' ? .010 + .015*energy
                : state==='listening' ? .008 + .010*energy
                : state==='processing' ? .008 : .004;
            morphAmp += (targetMorph-morphAmp)*(1-Math.exp(-dt*(targetMorph>morphAmp ? 6.0 : 2.5)));
            // Silence must look silent: an idle orb no longer opens up on room
            // noise, and listening is led by the caller's own phrase envelope.
            const targetActivity = state==='speaking' ? .92 : state==='processing' ? .80
                : state==='listening' ? Math.min(.85, .42 + energy * 1.1)
                : Math.min(.35, energy * 1.1);
            const wanted = activity + (targetActivity-activity) * (1-Math.exp(-dt*1.4));
            const slew = 1.1 * dt;
            activity += Math.max(-slew, Math.min(slew, wanted - activity));
            if (targetActivity===0 && activity<.001) activity=0;
            if (!reduced.matches) {
                const step = dt*speed*.20;
                time += dt*speed;
                const flow = step * (1 + 1.8*activity);
                driftA = wrap(driftA + flow*.72);
                driftB = wrap(driftB + flow*.41);
                driftC = wrap(driftC + flow*.90);
                spin = wrap(spin + step*(.7 + .3*speaking));
                breath = wrap(breath + step*(4.0 + .2*speaking));
                // The morph harmonics and the thinking breath are angles that
                // only ever accumulate.  Louder voice = faster reshaping; the
                // rates are incommensurate so the outline never visibly loops.
                const morphRate = .2 + .2*thinking + speaking*(.4 + 1.2*energy) + listening*(.25 + .8*energy);
                const rates = [1.0, 1.37, .83];
                for (let i = 0; i < 3; i++) morph[i] = wrap(morph[i] + dt*morphRate*rates[i]);
                morph[3] = wrap(morph[3] + dt*TAU/2.4);
            }
            const size = Math.max(1,Math.min(600,Math.round(width*pixelRatio/2)*2));
            const key = `${size}:${theme}:${reduced.matches}`;
            // Half a frame of slack: a plain `< 1000/30` test against a 60 Hz
            // rAF alternates 33 ms and 50 ms frames, which reads as judder.
            if (key===lastKey && (reduced.matches || now-lastDraw < 1000/30 - 1000/120)) return;
            lastDraw=now; lastKey=key;
            if (canvas.width!==size || canvas.height!==size) {canvas.width=size;canvas.height=size;gl.viewport(0,0,size,size);}
            gl.useProgram(program);
            gl.uniform2f(uniforms.uResolution,size,size);
            gl.uniform1f(uniforms.uTime,reduced.matches ? 0 : time);
            gl.uniform1f(uniforms.uEnergy,reduced.matches ? 0 : energy);
            gl.uniform1f(uniforms.uPulse,reduced.matches ? 0 : Math.max(0, pulse - energy));
            gl.uniform1f(uniforms.uActivity,reduced.matches ? 0 : activity);
            gl.uniform2f(uniforms.uModes,reduced.matches ? 0 : speaking,reduced.matches ? 0 : thinking);
            gl.uniform3f(uniforms.uDrift,reduced.matches ? 0 : driftA,reduced.matches ? 0 : driftB,reduced.matches ? 0 : driftC);
            gl.uniform1f(uniforms.uSpin,reduced.matches ? 0 : spin);
            gl.uniform1f(uniforms.uBreath,reduced.matches ? 0 : breath);
            // Reduced motion still tells the states apart, just without movement.
            gl.uniform4f(uniforms.uState,idleW,listening,reduced.matches ? 0 : thinking,reduced.matches ? 0 : speaking);
gl.uniform1f(uniforms.uScale,reduced.matches ? targetScaleFor(state) : scale);
            gl.uniform2f(uniforms.uSquash,reduced.matches ? 1 : 1+squash,reduced.matches ? 1 : 1-squash*.8);
            gl.uniform2f(uniforms.uSlosh,reduced.matches ? 0 : slosh,reduced.matches ? 0 : squash*1.6);
            gl.uniform4f(uniforms.uMorph,morph[0],morph[1],morph[2],reduced.matches ? 0 : morph[3]);
            gl.uniform1f(uniforms.uMorphAmp,reduced.matches ? 0 : morphAmp);
            gl.uniform1f(uniforms.uTheme,themes[theme] ?? 0);
            gl.drawArrays(gl.TRIANGLES,0,3);
        },
        /** Release graphics resources when the page is discarded. */
        dispose() {
            observer.disconnect(); canvas.removeEventListener('webglcontextlost',lost); canvas.removeEventListener('webglcontextrestored',initialize);
            if (ready) {gl.deleteBuffer(buffer);gl.deleteProgram(program);}
            ready=false;
        },
    };
}
