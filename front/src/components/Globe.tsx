import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { feature } from 'topojson-client';

export interface GlobeMarker {
  id: string;
  lat: number;
  lng: number;
  name: string;
  markerType: 'local' | 'global';
  color?: number;
  ip?: string;
  country?: string;
  city?: string;
}

export const GLOBE_TEXTURES = [
  { label: 'Realistic', url: 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg' as string | null },
  { label: 'Night',     url: 'https://unpkg.com/three-globe/example/img/earth-night.jpg'        as string | null },
  { label: 'Simple',   url: 'borders'                                                            as string | null },
];

interface Props {
  markers?: GlobeMarker[];
  onMarkerClick?: (marker: GlobeMarker) => void;
  textureUrl?: string | null;
  focusTarget?: { lat: number; lng: number } | null;
}

const RADIUS   = 2;
const DOT_R    = 0.013;
const MIN_DIST = DOT_R * 2.5;
const LABEL_R  = RADIUS * 1.20;
const LABEL_GAP = 0.65;

function latLngToVec3(lat: number, lng: number, r = RADIUS): THREE.Vector3 {
  const phi   = (90 - lat)  * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  );
}

function noOverlapPositions(markers: GlobeMarker[]): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();
  const placed: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (const m of markers) {
    const base = latLngToVec3(m.lat, m.lng, RADIUS * 1.005);
    let pos = base.clone();

    if (placed.some(p => p.distanceTo(pos) < MIN_DIST)) {
      const up    = base.clone().normalize();
      const tmp   = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const right = new THREE.Vector3().crossVectors(up, tmp).normalize();
      const fwd   = new THREE.Vector3().crossVectors(up, right).normalize();

      for (let k = 1; k <= 60; k++) {
        const angle     = k * golden;
        const offset    = 0.025 * Math.sqrt(k);
        const candidate = base.clone()
          .addScaledVector(right, offset * Math.cos(angle))
          .addScaledVector(fwd,   offset * Math.sin(angle))
          .normalize()
          .multiplyScalar(RADIUS * 1.005);
        if (!placed.some(p => p.distanceTo(candidate) < MIN_DIST)) {
          pos = candidate;
          break;
        }
      }
    }

    placed.push(pos);
    positions.set(m.id, pos);
  }

  return positions;
}

async function buildBordersTexture(): Promise<THREE.CanvasTexture> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topo: any = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json());
  const countries = feature(topo, topo.objects.countries) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  const W = 2048, H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#1a3a2a';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#3a7060';
  ctx.lineWidth   = 0.8;

  const project = (lon: number, lat: number): [number, number] => [
    (lon + 180) / 360 * W,
    (90 - lat)  / 180 * H,
  ];

  const drawRing = (ring: [number, number][]) => {
    if (!ring.length) return;
    ctx.moveTo(...project(ring[0][0], ring[0][1]));
    for (let i = 1; i < ring.length; i++) ctx.lineTo(...project(ring[i][0], ring[i][1]));
    ctx.closePath();
  };

  for (const feat of countries.features) {
    const geom = feat.geometry;
    ctx.beginPath();
    if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates) drawRing(ring);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates)
        for (const ring of poly) drawRing(ring);
    }
    ctx.stroke();
  }

  return new THREE.CanvasTexture(canvas);
}

function makeLabel(name: string, markerType: 'local' | 'global'): THREE.Sprite {
  const canvas  = document.createElement('canvas');
  canvas.width  = 320;
  canvas.height = 80;
  const ctx     = canvas.getContext('2d')!;
  ctx.font      = 'bold 28px system-ui';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(name.length > 16 ? name.slice(0, 15) + '…' : name, 160, 30);
  ctx.font      = '20px system-ui';
  ctx.fillStyle = markerType === 'local' ? '#00e5ff' : '#ffaa00';
  ctx.fillText(markerType, 160, 58);
  const sprite  = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }));
  sprite.scale.set(0.75, 0.19, 1);
  return sprite;
}

export default function Globe({ markers = [], onMarkerClick, textureUrl = GLOBE_TEXTURES[0].url, focusTarget }: Props) {
  const mountRef      = useRef<HTMLDivElement>(null);
  const cameraRef     = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef   = useRef<OrbitControls | null>(null);
  const earthMatRef   = useRef<THREE.MeshPhongMaterial | null>(null);
  const dotsGrpRef    = useRef<THREE.Group | null>(null);
  const labelsGrpRef  = useRef<THREE.Group | null>(null);
  const markerDataRef = useRef(new Map<THREE.Mesh, GlobeMarker>());
  const targetPosRef  = useRef<THREE.Vector3 | null>(null);
  const onClickRef    = useRef(onMarkerClick);

  useEffect(() => { onClickRef.current = onMarkerClick; }, [onMarkerClick]);

  useEffect(() => {
    const mount    = mountRef.current!;
    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.1, 1000);
    camera.position.z = 6;
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls          = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping   = true;
    controls.dampingFactor   = 0.05;
    controls.minDistance     = 2.5;
    controls.maxDistance     = 10;
    controls.autoRotate      = true;
    controls.autoRotateSpeed = 0.4;
    controlsRef.current     = controls;

    const earthMat = new THREE.MeshPhongMaterial({ specular: new THREE.Color(0x111111), shininess: 8 });
    earthMatRef.current = earthMat;
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 64, 64), earthMat));

    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS * 1.02, 64, 64),
      new THREE.MeshPhongMaterial({ color: 0x2255cc, transparent: true, opacity: 0.07, side: THREE.BackSide }),
    ));

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(5, 3, 5);
    scene.add(sun);

    const starPos = new Float32Array(6000);
    for (let i = 0; i < starPos.length; i++) starPos[i] = (Math.random() - 0.5) * 400;
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.2 })));

    const dotsGrp   = new THREE.Group();
    const labelsGrp = new THREE.Group();
    dotsGrpRef.current   = dotsGrp;
    labelsGrpRef.current = labelsGrp;
    scene.add(dotsGrp, labelsGrp);

    const raycaster = new THREE.Raycaster();
    const mouse     = new THREE.Vector2();
    let mouseDownX = 0, mouseDownY = 0;

    const onMouseDown = (e: MouseEvent) => { mouseDownX = e.clientX; mouseDownY = e.clientY; };
    const onClick     = (e: MouseEvent) => {
      if ((e.clientX - mouseDownX) ** 2 + (e.clientY - mouseDownY) ** 2 > 16) return;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(dotsGrp.children);
      if (hits.length > 0) {
        const data = markerDataRef.current.get(hits[0].object as THREE.Mesh);
        if (data) onClickRef.current?.(data);
      }
    };

    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('click', onClick);

    const ro = new ResizeObserver(() => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    });
    ro.observe(mount);

    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      if (targetPosRef.current) {
        camera.position.lerp(targetPosRef.current, 0.05);
        if (camera.position.distanceTo(targetPosRef.current) < 0.08) targetPosRef.current = null;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      renderer.domElement.removeEventListener('mousedown', onMouseDown);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const mat = earthMatRef.current;
    if (!mat) return;
    if (!textureUrl) {
      mat.map   = null;
      mat.color = new THREE.Color(0x1a3a2a);
      mat.needsUpdate = true;
    } else if (textureUrl === 'borders') {
      buildBordersTexture().then(tex => {
        mat.map   = tex;
        mat.color = new THREE.Color(0xffffff);
        mat.needsUpdate = true;
      });
    } else {
      new THREE.TextureLoader().load(textureUrl, tex => {
        mat.map   = tex;
        mat.color = new THREE.Color(0xffffff);
        mat.needsUpdate = true;
      });
    }
  }, [textureUrl]);

  useEffect(() => {
    if (!focusTarget || !cameraRef.current) return;
    const dist = cameraRef.current.position.length();
    targetPosRef.current = latLngToVec3(focusTarget.lat, focusTarget.lng).normalize().multiplyScalar(dist);
    if (controlsRef.current) controlsRef.current.autoRotate = false;
  }, [focusTarget]);

  useEffect(() => {
    const dGrp = dotsGrpRef.current;
    const lGrp = labelsGrpRef.current;
    if (!dGrp || !lGrp) return;

    const disposeGroup = (g: THREE.Group) => {
      g.children.forEach(c => {
        const mat = (c as THREE.Mesh | THREE.Sprite).material as THREE.Material & { map?: THREE.Texture };
        mat.map?.dispose();
        mat.dispose();
      });
      g.clear();
    };
    disposeGroup(dGrp);
    disposeGroup(lGrp);
    markerDataRef.current.clear();

    const dotGeo    = new THREE.SphereGeometry(DOT_R, 8, 8);
    const positions = noOverlapPositions(markers);
    const usedLabelPos: THREE.Vector3[] = [];

    for (const marker of markers) {
      const pos          = positions.get(marker.id) ?? latLngToVec3(marker.lat, marker.lng, RADIUS * 1.005);
      const defaultColor = marker.markerType === 'global' ? 0xffaa00 : 0xff3344;
      const mesh         = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: marker.color ?? defaultColor }));
      mesh.position.copy(pos);
      dGrp.add(mesh);
      markerDataRef.current.set(mesh, marker);

      const lv       = latLngToVec3(marker.lat, marker.lng, LABEL_R);
      const tooClose = usedLabelPos.some(v => v.distanceTo(lv) < LABEL_GAP);
      if (!tooClose) {
        usedLabelPos.push(lv);
        const label = makeLabel(marker.name, marker.markerType);
        label.position.copy(lv);
        lGrp.add(label);
      }
    }
  }, [markers]);

  return <div ref={mountRef} style={{ width: '100%', height: '100%' }} />;
}
