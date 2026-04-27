/**
 * Minimal GLTFLoader for Three.js r128 (classic globals)
 * Supports: GLB binary, static meshes, PBR materials
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  if (!THREE) { console.error('GLTFLoader: THREE not found'); return; }

  var CTYPES = {
    5120: Int8Array, 5121: Uint8Array,
    5122: Int16Array, 5123: Uint16Array,
    5125: Uint32Array, 5126: Float32Array
  };
  var TSIZE = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16 };

  /* ---- Loader ---- */
  function GLTFLoader(manager) {
    THREE.Loader.call(this, manager);
  }
  GLTFLoader.prototype = Object.assign(Object.create(THREE.Loader.prototype), {
    constructor: GLTFLoader,
    load: function (url, onLoad, onProgress, onError) {
      var self = this;
      var fl = new THREE.FileLoader(this.manager);
      fl.setPath(this.path);
      fl.setResponseType('arraybuffer');
      fl.setRequestHeader(this.requestHeader);
      fl.setWithCredentials(this.withCredentials);
      fl.load(url, function (buf) {
        try { self.parse(buf, '', onLoad, onError); }
        catch (e) { if (onError) onError(e); else console.error(e); self.manager.itemError(url); }
      }, onProgress, onError);
    },
    parse: function (data, path, onLoad, onError) {
      try { onLoad(parseGLB(data)); }
      catch (e) { if (onError) onError(e); else console.error(e); }
    }
  });

  /* ---- GLB parser ---- */
  function parseGLB(buffer) {
    var view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB file');

    var chunk0Len  = view.getUint32(12, true);
    var jsonBytes  = new Uint8Array(buffer, 20, chunk0Len);
    var json       = JSON.parse(new TextDecoder().decode(jsonBytes));

    var binBuffer  = null;
    var binStart   = 20 + chunk0Len;
    if (binStart + 8 <= buffer.byteLength) {
      var chunk1Len = view.getUint32(binStart, true);
      binBuffer = buffer.slice(binStart + 8, binStart + 8 + chunk1Len);
    }

    return buildScene(json, binBuffer ? [binBuffer] : []);
  }

  /* ---- Scene builder ---- */
  function buildScene(json, buffers) {

    function getAccessorArray(idx) {
      var acc  = json.accessors[idx];
      var bv   = json.bufferViews[acc.bufferView];
      var buf  = buffers[bv.buffer];
      var TA   = CTYPES[acc.componentType];
      var nc   = TSIZE[acc.type];
      var boff = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      var stride = bv.byteStride || 0;
      var natural = TA.BYTES_PER_ELEMENT * nc;

      if (!stride || stride === natural) {
        return new TA(buf, boff, acc.count * nc);
      }
      // interleaved
      var out = new TA(acc.count * nc);
      var src = new DataView(buf, boff);
      var getter = TA === Float32Array ? 'getFloat32' :
                   TA === Uint32Array  ? 'getUint32'  :
                   TA === Uint16Array  ? 'getUint16'  :
                   TA === Int16Array   ? 'getInt16'   :
                   TA === Uint8Array   ? 'getUint8'   : 'getInt8';
      for (var i = 0; i < acc.count; i++) {
        for (var j = 0; j < nc; j++) {
          out[i * nc + j] = src[getter](i * stride + j * TA.BYTES_PER_ELEMENT, true);
        }
      }
      return out;
    }

    /* materials */
    var defaultMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.4, roughness: 0.6 });
    var materials = (json.materials || []).map(function (m) {
      var mat = new THREE.MeshStandardMaterial();
      mat.name = m.name || '';
      var pbr = m.pbrMetallicRoughness || {};
      if (pbr.baseColorFactor) {
        mat.color.setRGB(pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]);
        mat.opacity = pbr.baseColorFactor[3] !== undefined ? pbr.baseColorFactor[3] : 1;
      }
      mat.metalness = pbr.metallicFactor  !== undefined ? pbr.metallicFactor  : 1;
      mat.roughness = pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1;
      if (m.alphaMode === 'BLEND') { mat.transparent = true; }
      if (m.alphaMode === 'MASK')  { mat.alphaTest = m.alphaCutoff !== undefined ? m.alphaCutoff : 0.5; }
      mat.side = m.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      return mat;
    });

    /* mesh groups */
    var meshGroups = (json.meshes || []).map(function (mesh) {
      var g = new THREE.Group();
      g.name = mesh.name || '';
      (mesh.primitives || []).forEach(function (prim) {
        var geo  = new THREE.BufferGeometry();
        var attr = prim.attributes || {};
        if (attr.POSITION  !== undefined) geo.setAttribute('position', new THREE.BufferAttribute(getAccessorArray(attr.POSITION), 3));
        if (attr.NORMAL    !== undefined) geo.setAttribute('normal',   new THREE.BufferAttribute(getAccessorArray(attr.NORMAL),   3));
        if (attr.TEXCOORD_0 !== undefined) geo.setAttribute('uv',     new THREE.BufferAttribute(getAccessorArray(attr.TEXCOORD_0), 2));
        if (prim.indices   !== undefined) geo.setIndex(new THREE.BufferAttribute(getAccessorArray(prim.indices), 1));
        if (!geo.attributes.normal) geo.computeVertexNormals();
        var mat = prim.material !== undefined ? materials[prim.material] : defaultMat;
        g.add(new THREE.Mesh(geo, mat));
      });
      return g;
    });

    /* node tree */
    function buildNode(ni) {
      var nd  = json.nodes[ni];
      var obj = new THREE.Object3D();
      obj.name = nd.name || '';
      if (nd.matrix) {
        obj.matrix.fromArray(nd.matrix);
        obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
        obj.matrixAutoUpdate = false;
      } else {
        if (nd.translation) obj.position.fromArray(nd.translation);
        if (nd.rotation)    obj.quaternion.fromArray(nd.rotation);
        if (nd.scale)       obj.scale.fromArray(nd.scale);
      }
      if (nd.mesh !== undefined) obj.add(meshGroups[nd.mesh].clone());
      if (nd.children) nd.children.forEach(function (ci) { obj.add(buildNode(ci)); });
      return obj;
    }

    var scene   = new THREE.Group();
    scene.name  = 'Scene';
    var si      = json.scene !== undefined ? json.scene : 0;
    var sceneDef = json.scenes ? json.scenes[si] : null;
    if (sceneDef && sceneDef.nodes) {
      sceneDef.nodes.forEach(function (ni) { scene.add(buildNode(ni)); });
    }

    return { scene: scene, scenes: [scene], cameras: [], animations: [], asset: json.asset || {} };
  }

  THREE.GLTFLoader = GLTFLoader;

})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : typeof global !== 'undefined' ? global : this);
