/**
 * Minimal GLTFLoader for Three.js r128
 * Supports: GLB binary, static meshes, PBR materials
 */
(function (global) {
  'use strict';

  const THREE = global.THREE;
  if (!THREE) { console.error('GLTFLoader: THREE not found'); return; }

  const CTYPES = {
    5120: Int8Array,  5121: Uint8Array,
    5122: Int16Array, 5123: Uint16Array,
    5125: Uint32Array, 5126: Float32Array
  };
  const TSIZE = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16 };

  class GLTFLoader extends THREE.Loader {
    load(url, onLoad, onProgress, onError) {
      const fl = new THREE.FileLoader(this.manager);
      fl.setPath(this.path);
      fl.setResponseType('arraybuffer');
      fl.setRequestHeader(this.requestHeader);
      fl.setWithCredentials(this.withCredentials);
      fl.load(url, (buf) => {
        try { this.parse(buf, '', onLoad, onError); }
        catch (e) { if (onError) onError(e); else console.error(e); this.manager.itemError(url); }
      }, onProgress, onError);
    }

    parse(data, path, onLoad, onError) {
      try { onLoad(parseGLB(data)); }
      catch (e) { if (onError) onError(e); else console.error(e); }
    }
  }

  /* ---- GLB binary parser ---- */
  function parseGLB(buffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB file');

    const chunk0Len = view.getUint32(12, true);
    const jsonBytes = new Uint8Array(buffer, 20, chunk0Len);
    const json      = JSON.parse(new TextDecoder().decode(jsonBytes));

    let binBuffer = null;
    const binStart = 20 + chunk0Len;
    if (binStart + 8 <= buffer.byteLength) {
      const chunk1Len = view.getUint32(binStart, true);
      binBuffer = buffer.slice(binStart + 8, binStart + 8 + chunk1Len);
    }

    return buildScene(json, binBuffer ? [binBuffer] : []);
  }

  /* ---- Scene builder ---- */
  function buildScene(json, buffers) {

    function getAccessorArray(idx) {
      const acc  = json.accessors[idx];
      const bv   = json.bufferViews[acc.bufferView];
      const buf  = buffers[bv.buffer];
      const TA   = CTYPES[acc.componentType];
      const nc   = TSIZE[acc.type];
      const boff = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const stride  = bv.byteStride || 0;
      const natural = TA.BYTES_PER_ELEMENT * nc;

      if (!stride || stride === natural) {
        return new TA(buf, boff, acc.count * nc);
      }
      // interleaved data — copy to compact array
      const out = new TA(acc.count * nc);
      const src = new DataView(buf, boff);
      const getter =
        TA === Float32Array ? 'getFloat32' :
        TA === Uint32Array  ? 'getUint32'  :
        TA === Uint16Array  ? 'getUint16'  :
        TA === Int16Array   ? 'getInt16'   :
        TA === Uint8Array   ? 'getUint8'   : 'getInt8';
      for (let i = 0; i < acc.count; i++) {
        for (let j = 0; j < nc; j++) {
          out[i * nc + j] = src[getter](i * stride + j * TA.BYTES_PER_ELEMENT, true);
        }
      }
      return out;
    }

    /* materials */
    const defaultMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.4, roughness: 0.6 });
    const materials = (json.materials || []).map(m => {
      const mat = new THREE.MeshStandardMaterial();
      mat.name  = m.name || '';
      const pbr = m.pbrMetallicRoughness || {};
      if (pbr.baseColorFactor) {
        mat.color.setRGB(pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]);
        mat.opacity = pbr.baseColorFactor[3] ?? 1;
      }
      mat.metalness  = pbr.metallicFactor  ?? 1;
      mat.roughness  = pbr.roughnessFactor ?? 1;
      if (m.alphaMode === 'BLEND') mat.transparent = true;
      if (m.alphaMode === 'MASK')  mat.alphaTest   = m.alphaCutoff ?? 0.5;
      mat.side = m.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      return mat;
    });

    /* meshes */
    const meshGroups = (json.meshes || []).map(mesh => {
      const g = new THREE.Group();
      g.name  = mesh.name || '';
      (mesh.primitives || []).forEach(prim => {
        const geo  = new THREE.BufferGeometry();
        const attr = prim.attributes || {};
        if (attr.POSITION   != null) geo.setAttribute('position', new THREE.BufferAttribute(getAccessorArray(attr.POSITION),   3));
        if (attr.NORMAL     != null) geo.setAttribute('normal',   new THREE.BufferAttribute(getAccessorArray(attr.NORMAL),     3));
        if (attr.TEXCOORD_0 != null) geo.setAttribute('uv',       new THREE.BufferAttribute(getAccessorArray(attr.TEXCOORD_0), 2));
        if (prim.indices    != null) geo.setIndex(new THREE.BufferAttribute(getAccessorArray(prim.indices), 1));
        if (!geo.attributes.normal) geo.computeVertexNormals();
        const mat = prim.material != null ? materials[prim.material] : defaultMat;
        g.add(new THREE.Mesh(geo, mat));
      });
      return g;
    });

    /* node tree */
    function buildNode(ni) {
      const nd  = json.nodes[ni];
      const obj = new THREE.Object3D();
      obj.name  = nd.name || '';
      if (nd.matrix) {
        obj.matrix.fromArray(nd.matrix);
        obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
        obj.matrixAutoUpdate = false;
      } else {
        if (nd.translation) obj.position.fromArray(nd.translation);
        if (nd.rotation)    obj.quaternion.fromArray(nd.rotation);
        if (nd.scale)       obj.scale.fromArray(nd.scale);
      }
      if (nd.mesh != null) obj.add(meshGroups[nd.mesh].clone());
      if (nd.children) nd.children.forEach(ci => obj.add(buildNode(ci)));
      return obj;
    }

    const scene  = new THREE.Group();
    scene.name   = 'Scene';
    const si     = json.scene ?? 0;
    const sDef   = json.scenes?.[si];
    if (sDef?.nodes) sDef.nodes.forEach(ni => scene.add(buildNode(ni)));

    return { scene, scenes: [scene], cameras: [], animations: [], asset: json.asset || {} };
  }

  THREE.GLTFLoader = GLTFLoader;

})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
