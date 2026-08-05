var _e=Object.defineProperty;var Ae=(m,i,l)=>i in m?_e(m,i,{enumerable:!0,configurable:!0,writable:!0,value:l}):m[i]=l;var K=(m,i,l)=>Ae(m,typeof i!="symbol"?i+"":i,l);import{r as he,j as Se}from"./index-BXp65mg1.js";const f={SIM_RESOLUTION:72,DYE_RESOLUTION:384,DENSITY_DISSIPATION:4.5,VELOCITY_DISSIPATION:2.6,PRESSURE:.1,PRESSURE_ITERATIONS:16,CURL:2.5,SPLAT_RADIUS:.16,SPLAT_FORCE:5e3,INTENSITY:.16,CLICK_GAIN:2.2,IDLE_MS:2e3};function $(){const m=.5+Math.random()*.06,i=be(m,.7+Math.random()*.25,.75+Math.random()*.25);return{r:i.r*f.INTENSITY,g:i.g*f.INTENSITY,b:i.b*f.INTENSITY}}function ye(){const m=he.useRef(null);return he.useEffect(()=>{const i=m.current;if(!i)return;const l=i.getContext("webgl2",{alpha:!0,depth:!1,stencil:!1,antialias:!1,preserveDrawingBuffer:!1});if(!l)return;const e=l;e.getExtension("EXT_color_buffer_float");const D=!!e.getExtension("OES_texture_float_linear"),d=e.HALF_FLOAT,U=(t,r,n)=>{const u=e.createTexture();e.bindTexture(e.TEXTURE_2D,u),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,t,4,4,0,r,n,null);const a=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,a),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,u,0);const c=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;return e.bindFramebuffer(e.FRAMEBUFFER,null),e.deleteFramebuffer(a),e.deleteTexture(u),c},g=(t,r,n)=>U(t,r,n)?{internalFormat:t,format:r}:t===e.R16F?g(e.RG16F,e.RG,n):t===e.RG16F?g(e.RGBA16F,e.RGBA,n):null,C=g(e.RGBA16F,e.RGBA,d),M=g(e.RG16F,e.RG,d),F=g(e.R16F,e.RED,d);if(!C||!M||!F)return;const E=(t,r,n)=>{const u=(n==null?void 0:n.map(c=>`#define ${c}
`).join(""))??"",a=e.createShader(t);return a?(e.shaderSource(a,u+r),e.compileShader(a),e.getShaderParameter(a,e.COMPILE_STATUS)?a:(console.warn(e.getShaderInfoLog(a)),null)):null};class p{constructor(r,n){K(this,"program");K(this,"uniforms",{});this.program=e.createProgram(),e.attachShader(this.program,r),e.attachShader(this.program,n),e.linkProgram(this.program),e.getProgramParameter(this.program,e.LINK_STATUS)||console.warn(e.getProgramInfoLog(this.program));const u=e.getProgramParameter(this.program,e.ACTIVE_UNIFORMS);for(let a=0;a<u;a++){const c=e.getActiveUniform(this.program,a);c&&(this.uniforms[c.name]=e.getUniformLocation(this.program,c.name))}}bind(){e.useProgram(this.program)}}const J=E(e.VERTEX_SHADER,`precision highp float;
       attribute vec2 aPosition;
       varying vec2 vUv, vL, vR, vT, vB;
       uniform vec2 texelSize;
       void main () {
         vUv = aPosition * 0.5 + 0.5;
         vL = vUv - vec2(texelSize.x, 0.0);
         vR = vUv + vec2(texelSize.x, 0.0);
         vT = vUv + vec2(0.0, texelSize.y);
         vB = vUv - vec2(0.0, texelSize.y);
         gl_Position = vec4(aPosition, 0.0, 1.0);
       }`),Q=E(e.FRAGMENT_SHADER,`precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv;
       uniform sampler2D uTexture;
       uniform float value;
       void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`),Z=E(e.FRAGMENT_SHADER,`precision highp float;
       precision highp sampler2D;
       varying vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uTexture;
       uniform vec2 texelSize;
       void main () {
         vec3 c = texture2D(uTexture, vUv).rgb;
         #ifdef SHADING
           float dx = length(texture2D(uTexture, vR).rgb) - length(texture2D(uTexture, vL).rgb);
           float dy = length(texture2D(uTexture, vT).rgb) - length(texture2D(uTexture, vB).rgb);
           vec3 n = normalize(vec3(dx, dy, length(texelSize)));
           c *= clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
         #endif
         gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
       }`,["SHADING"]),k=E(e.FRAGMENT_SHADER,`precision highp float;
       precision highp sampler2D;
       varying vec2 vUv;
       uniform sampler2D uTarget;
       uniform float aspectRatio;
       uniform vec3 color;
       uniform vec2 point;
       uniform float radius;
       void main () {
         vec2 p = vUv - point.xy;
         p.x *= aspectRatio;
         vec3 splat = exp(-dot(p, p) / radius) * color;
         gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
       }`),ee=E(e.FRAGMENT_SHADER,`precision highp float;
       precision highp sampler2D;
       varying vec2 vUv;
       uniform sampler2D uVelocity;
       uniform sampler2D uSource;
       uniform vec2 texelSize;
       uniform vec2 dyeTexelSize;
       uniform float dt;
       uniform float dissipation;

       vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
         vec2 st = uv / tsize - 0.5;
         vec2 iuv = floor(st);
         vec2 fuv = fract(st);
         vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
         vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
         vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
         vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
         return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
       }

       void main () {
         #ifdef MANUAL_FILTERING
           vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
           vec4 result = bilerp(uSource, coord, dyeTexelSize);
         #else
           vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
           vec4 result = texture2D(uSource, coord);
         #endif
         gl_FragColor = result / (1.0 + dissipation * dt);
       }`,D?void 0:["MANUAL_FILTERING"]),te=E(e.FRAGMENT_SHADER,`precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uVelocity;
       void main () {
         float L = texture2D(uVelocity, vL).x;
         float R = texture2D(uVelocity, vR).x;
         float T = texture2D(uVelocity, vT).y;
         float B = texture2D(uVelocity, vB).y;
         vec2 C = texture2D(uVelocity, vUv).xy;
         if (vL.x < 0.0) { L = -C.x; }
         if (vR.x > 1.0) { R = -C.x; }
         if (vT.y > 1.0) { T = -C.y; }
         if (vB.y < 0.0) { B = -C.y; }
         gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
       }`),re=E(e.FRAGMENT_SHADER,`precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uVelocity;
       void main () {
         float L = texture2D(uVelocity, vL).y;
         float R = texture2D(uVelocity, vR).y;
         float T = texture2D(uVelocity, vT).x;
         float B = texture2D(uVelocity, vB).x;
         gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
       }`),ie=E(e.FRAGMENT_SHADER,`precision highp float;
       precision highp sampler2D;
       varying vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uVelocity;
       uniform sampler2D uCurl;
       uniform float curl;
       uniform float dt;
       void main () {
         float L = texture2D(uCurl, vL).x;
         float R = texture2D(uCurl, vR).x;
         float T = texture2D(uCurl, vT).x;
         float B = texture2D(uCurl, vB).x;
         float C = texture2D(uCurl, vUv).x;
         vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
         force /= length(force) + 0.0001;
         force *= curl * C;
         force.y *= -1.0;
         vec2 velocity = texture2D(uVelocity, vUv).xy + force * dt;
         gl_FragColor = vec4(min(max(velocity, -1000.0), 1000.0), 0.0, 1.0);
       }`),oe=E(e.FRAGMENT_SHADER,`precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uPressure;
       uniform sampler2D uDivergence;
       void main () {
         float L = texture2D(uPressure, vL).x;
         float R = texture2D(uPressure, vR).x;
         float T = texture2D(uPressure, vT).x;
         float B = texture2D(uPressure, vB).x;
         float divergence = texture2D(uDivergence, vUv).x;
         gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
       }`),ne=E(e.FRAGMENT_SHADER,`precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uPressure;
       uniform sampler2D uVelocity;
       void main () {
         float L = texture2D(uPressure, vL).x;
         float R = texture2D(uPressure, vR).x;
         float T = texture2D(uPressure, vT).x;
         float B = texture2D(uPressure, vB).x;
         vec2 velocity = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
         gl_FragColor = vec4(velocity, 0.0, 1.0);
       }`);if([J,Q,Z,k,ee,te,re,ie,oe,ne].some(t=>t===null))return;const h=J,X=new p(h,Q),z=new p(h,Z),S=new p(h,k),x=new p(h,ee),O=new p(h,te),Y=new p(h,re),A=new p(h,ie),I=new p(h,oe),P=new p(h,ne),ae=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,ae),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,-1,1,1,1,1,-1]),e.STATIC_DRAW);const ue=e.createBuffer();e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,ue),e.bufferData(e.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,0,2,3]),e.STATIC_DRAW),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.enableVertexAttribArray(0);const T=t=>{t===null?(e.viewport(0,0,e.drawingBufferWidth,e.drawingBufferHeight),e.bindFramebuffer(e.FRAMEBUFFER,null)):(e.viewport(0,0,t.width,t.height),e.bindFramebuffer(e.FRAMEBUFFER,t.fbo)),e.drawElements(e.TRIANGLES,6,e.UNSIGNED_SHORT,0)},B=(t,r,n,u,a)=>{e.activeTexture(e.TEXTURE0);const c=e.createTexture();e.bindTexture(e.TEXTURE_2D,c),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,a),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,a),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,n,t,r,0,u,d,null);const _=e.createFramebuffer();return e.bindFramebuffer(e.FRAMEBUFFER,_),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,c,0),e.viewport(0,0,t,r),e.clear(e.COLOR_BUFFER_BIT),{texture:c,fbo:_,width:t,height:r,texelSizeX:1/t,texelSizeY:1/r,attach(pe){return e.activeTexture(e.TEXTURE0+pe),e.bindTexture(e.TEXTURE_2D,c),pe}}},G=(t,r,n,u,a)=>{const c={width:t,height:r,texelSizeX:1/t,texelSizeY:1/r,read:B(t,r,n,u,a),write:B(t,r,n,u,a),swap(){const _=c.read;c.read=c.write,c.write=_}};return c},se=t=>{const r=e.drawingBufferWidth/e.drawingBufferHeight,n=r<1?1/r:r,u=Math.round(t),a=Math.round(t*n);return e.drawingBufferWidth>e.drawingBufferHeight?{width:a,height:u}:{width:u,height:a}},ce=D?e.LINEAR:e.NEAREST;let v,o,L,w,R;const V=t=>{for(const r of[t.read,t.write])e.deleteFramebuffer(r.fbo),e.deleteTexture(r.texture)},le=t=>{e.deleteFramebuffer(t.fbo),e.deleteTexture(t.texture)},fe=()=>{const t=se(f.SIM_RESOLUTION),r=se(f.DYE_RESOLUTION);e.disable(e.BLEND),v&&V(v),o&&V(o),L&&le(L),w&&le(w),R&&V(R),v=G(r.width,r.height,C.internalFormat,C.format,ce),o=G(t.width,t.height,M.internalFormat,M.format,ce),L=B(t.width,t.height,F.internalFormat,F.format,e.NEAREST),w=B(t.width,t.height,F.internalFormat,F.format,e.NEAREST),R=G(t.width,t.height,F.internalFormat,F.format,e.NEAREST)},N=t=>Math.floor(t*(window.devicePixelRatio||1)),me=()=>{const t=Math.min(window.devicePixelRatio||1,2),r=Math.floor(i.clientWidth*t),n=Math.floor(i.clientHeight*t);return i.width!==r||i.height!==n?(i.width=r,i.height=n,!0):!1};me(),fe();const De=t=>{e.disable(e.BLEND),Y.bind(),e.uniform2f(Y.uniforms.texelSize,o.texelSizeX,o.texelSizeY),e.uniform1i(Y.uniforms.uVelocity,o.read.attach(0)),T(w),A.bind(),e.uniform2f(A.uniforms.texelSize,o.texelSizeX,o.texelSizeY),e.uniform1i(A.uniforms.uVelocity,o.read.attach(0)),e.uniform1i(A.uniforms.uCurl,w.attach(1)),e.uniform1f(A.uniforms.curl,f.CURL),e.uniform1f(A.uniforms.dt,t),T(o.write),o.swap(),O.bind(),e.uniform2f(O.uniforms.texelSize,o.texelSizeX,o.texelSizeY),e.uniform1i(O.uniforms.uVelocity,o.read.attach(0)),T(L),X.bind(),e.uniform1i(X.uniforms.uTexture,R.read.attach(0)),e.uniform1f(X.uniforms.value,f.PRESSURE),T(R.write),R.swap(),I.bind(),e.uniform2f(I.uniforms.texelSize,o.texelSizeX,o.texelSizeY),e.uniform1i(I.uniforms.uDivergence,L.attach(0));for(let n=0;n<f.PRESSURE_ITERATIONS;n++)e.uniform1i(I.uniforms.uPressure,R.read.attach(1)),T(R.write),R.swap();P.bind(),e.uniform2f(P.uniforms.texelSize,o.texelSizeX,o.texelSizeY),e.uniform1i(P.uniforms.uPressure,R.read.attach(0)),e.uniform1i(P.uniforms.uVelocity,o.read.attach(1)),T(o.write),o.swap(),x.bind(),e.uniform2f(x.uniforms.texelSize,o.texelSizeX,o.texelSizeY),D||e.uniform2f(x.uniforms.dyeTexelSize,o.texelSizeX,o.texelSizeY);const r=o.read.attach(0);e.uniform1i(x.uniforms.uVelocity,r),e.uniform1i(x.uniforms.uSource,r),e.uniform1f(x.uniforms.dt,t),e.uniform1f(x.uniforms.dissipation,f.VELOCITY_DISSIPATION),T(o.write),o.swap(),D||e.uniform2f(x.uniforms.dyeTexelSize,v.texelSizeX,v.texelSizeY),e.uniform1i(x.uniforms.uVelocity,o.read.attach(0)),e.uniform1i(x.uniforms.uSource,v.read.attach(1)),e.uniform1f(x.uniforms.dissipation,f.DENSITY_DISSIPATION),T(v.write),v.swap()},Fe=()=>{e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA),e.enable(e.BLEND),z.bind(),e.uniform2f(z.uniforms.texelSize,1/e.drawingBufferWidth,1/e.drawingBufferHeight),e.uniform1i(z.uniforms.uTexture,v.read.attach(0)),T(null)},ve=(t,r,n,u,a)=>{S.bind(),e.uniform1i(S.uniforms.uTarget,o.read.attach(0)),e.uniform1f(S.uniforms.aspectRatio,i.width/i.height),e.uniform2f(S.uniforms.point,t,r),e.uniform3f(S.uniforms.color,n,u,0);const c=i.width/i.height,_=f.SPLAT_RADIUS/100;e.uniform1f(S.uniforms.radius,c>1?_*c:_),T(o.write),o.swap(),e.uniform1i(S.uniforms.uTarget,v.read.attach(0)),e.uniform3f(S.uniforms.color,a.r,a.g,a.b),T(v.write),v.swap()},s={texcoordX:0,texcoordY:0,prevTexcoordX:0,prevTexcoordY:0,deltaX:0,deltaY:0,moved:!1,color:$()};let H=performance.now(),W=performance.now(),j=0,y=0,b=!1,q=!1;const de=()=>{const t=performance.now();let r=(t-W)/1e3;if(r=Math.min(r,.016666),W=t,me()&&fe(),j+=r*4,j>=1&&(j=0,s.color=$()),s.moved&&(s.moved=!1,ve(s.texcoordX,s.texcoordY,s.deltaX*f.SPLAT_FORCE,s.deltaY*f.SPLAT_FORCE,s.color)),De(r),Fe(),t-H>f.IDLE_MS){b=!1;return}y=requestAnimationFrame(de)},xe=()=>{b||q||document.hidden||(b=!0,W=performance.now(),y=requestAnimationFrame(de))},Te=t=>{const r=N(t.clientX),n=N(t.clientY);s.prevTexcoordX=s.texcoordX,s.prevTexcoordY=s.texcoordY,s.texcoordX=r/i.width,s.texcoordY=1-n/i.height;const u=i.width/i.height;let a=s.texcoordX-s.prevTexcoordX,c=s.texcoordY-s.prevTexcoordY;u<1&&(a*=u),u>1&&(c/=u),s.deltaX=a,s.deltaY=c,s.moved=a!==0||c!==0,H=performance.now(),xe()},Ee=t=>{const r=N(t.clientX),n=N(t.clientY);s.texcoordX=r/i.width,s.texcoordY=1-n/i.height;const u=$();ve(s.texcoordX,s.texcoordY,10*(Math.random()-.5),30*(Math.random()-.5),{r:u.r*f.CLICK_GAIN,g:u.g*f.CLICK_GAIN,b:u.b*f.CLICK_GAIN}),H=performance.now(),xe()},Re=()=>{document.hidden&&(cancelAnimationFrame(y),b=!1)},ge=()=>{q=!0,b=!1,cancelAnimationFrame(y),i.style.display="none"};return i.addEventListener("webglcontextlost",ge),window.addEventListener("mousemove",Te,{passive:!0}),window.addEventListener("mousedown",Ee,{passive:!0}),document.addEventListener("visibilitychange",Re),()=>{var t;i.removeEventListener("webglcontextlost",ge),q=!0,b=!1,cancelAnimationFrame(y),window.removeEventListener("mousemove",Te),window.removeEventListener("mousedown",Ee),document.removeEventListener("visibilitychange",Re),e.deleteBuffer(ae),e.deleteBuffer(ue),(t=e.getExtension("WEBGL_lose_context"))==null||t.loseContext()}},[]),Se.jsx("div",{className:"pointer-events-none fixed inset-0 z-[5]","aria-hidden":!0,children:Se.jsx("canvas",{ref:m,className:"h-full w-full"})})}function be(m,i,l){const e=Math.floor(m*6),D=m*6-e,d=l*(1-i),U=l*(1-D*i),g=l*(1-(1-D)*i);switch(e%6){case 0:return{r:l,g,b:d};case 1:return{r:U,g:l,b:d};case 2:return{r:d,g:l,b:g};case 3:return{r:d,g:U,b:l};case 4:return{r:g,g:d,b:l};default:return{r:l,g:d,b:U}}}export{ye as default};
