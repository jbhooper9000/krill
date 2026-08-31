import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));

      // gentle contrast
      c = (c - 0.5) * 1.07 + 0.5;

      // cool shadows, warm highlights
      c = mix(c, c * vec3(0.90, 1.0, 1.10), (1.0 - l) * 0.55);
      c = mix(c, c * vec3(1.06, 1.0, 0.94), l * 0.42);

      // very subtle breathing tint
      c += vec3(0.004, 0.008, 0.012) * sin(uTime * 0.4);

      // vignette
      float d = length(vUv - 0.5);
      c *= 1.0 - smoothstep(0.38, 0.95, d) * 0.55;

      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export class Effects {
  constructor(renderer, scene, camera) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.55, // strength
      0.45, // radius
      0.85 // threshold
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);
  }

  resize(w, h) {
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  }

  render(dt) {
    this.grade.uniforms.uTime.value += dt;
    this.composer.render();
  }
}
