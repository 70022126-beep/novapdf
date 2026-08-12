import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import "./ConvertPDF.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url
).toString();

const qualityMap = {
  low: { name: "Baja", value: 0.55 },
  medium: { name: "Media", value: 0.75 },
  high: { name: "Alta", value: 0.9 },
  maximum: { name: "Máxima", value: 1 }
};

const size = (n) => !n ? "0 KB" : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(2)} MB`;

function parsePages(text, total) {
  const out = new Set();
  text.split(",").map(x => x.trim()).filter(Boolean).forEach(part => {
    if (/^\d+$/.test(part)) {
      const n = +part; if (n >= 1 && n <= total) out.add(n);
    } else {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = +m[1], b = +m[2]; if (a > b) [a,b] = [b,a];
        for (let n = Math.max(1,a); n <= Math.min(total,b); n++) out.add(n);
      }
    }
  });
  return [...out].sort((a,b) => a-b);
}

function pageText(pages) {
  if (!pages.length) return "Todas";
  const a = [...pages].sort((x,y)=>x-y), r=[]; let s=a[0], q=a[0];
  for (let i=1;i<a.length;i++) {
    if (a[i]===q+1) q=a[i];
    else { r.push(s===q?`${s}`:`${s}-${q}`); s=q=a[i]; }
  }
  r.push(s===q?`${s}`:`${s}-${q}`);
  return r.join(", ");
}

function ConvertPDF() {
  const [mode,setMode]=useState("pdf");
  const [file,setFile]=useState(null);
  const [images,setImages]=useState([]);
  const [pdf,setPdf]=useState(null);
  const [pages,setPages]=useState(0);
  const [selected,setSelected]=useState([]);
  const [range,setRange]=useState("");
  const [visible,setVisible]=useState(8);
  const [format,setFormat]=useState("jpg");
  const [quality,setQuality]=useState("medium");
  const [dpi,setDpi]=useState(150);
  const [scale,setScale]=useState(100);
  const [drag,setDrag]=useState(false);
  const [processing,setProcessing]=useState(false);
  const [cancel,setCancel]=useState(false);
  const [progress,setProgress]=useState(0);
  const [current,setCurrent]=useState(0);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [download,setDownload]=useState("");
  const [downloadName,setDownloadName]=useState("");
  const [resultCount,setResultCount]=useState(0);
  const [dragIndex,setDragIndex]=useState(null);
  const input=useRef(null);

  const clearResult=()=>{ if(download) URL.revokeObjectURL(download); setDownload(""); setDownloadName(""); setResultCount(0); setProgress(0); };
  const reset=()=>{ if(processing)return; clearResult(); setFile(null); setImages([]); setPdf(null); setPages(0); setSelected([]); setRange(""); setVisible(8); setError(""); setMessage(""); setCancel(false); };

  useEffect(()=>()=>{if(download)URL.revokeObjectURL(download)},[download]);

  const loadFiles=async(list)=>{
    const files=[...list]; if(!files.length)return;
    setError(""); setMessage(""); clearResult();
    if(mode==="pdf"){
      const f=files[0], ok=f.type==="application/pdf"||/\.pdf$/i.test(f.name);
      if(!ok){setError("Selecciona un archivo PDF válido.");return;}
      try{
        const p=await pdfjsLib.getDocument({data:await f.arrayBuffer()}).promise;
        setFile(f); setImages([]); setPdf(p); setPages(p.numPages); setSelected([]); setVisible(Math.min(8,p.numPages));
      }catch(e){console.error(e);setError("No se pudo leer el PDF.");}
    }else{
      const imgs=files.filter(f=>/^image\/(jpeg|png|webp)$/i.test(f.type)||/\.(jpe?g|png|webp)$/i.test(f.name));
      if(!imgs.length){setError("Selecciona imágenes JPG, PNG o WebP.");return;}
      setImages(imgs); setFile(null); setPdf(null); setPages(imgs.length);
    }
  };

  const inputChange=e=>{loadFiles(e.target.files);e.target.value=""};
  const dragOver=e=>{e.preventDefault();setDrag(true)};
  const dragLeave=e=>{e.preventDefault();setDrag(false)};
  const drop=e=>{e.preventDefault();setDrag(false);loadFiles(e.dataTransfer.files)};

  const changeMode=m=>{if(processing)return;reset();setMode(m)};

  const toggle=n=>{if(processing)return;setSelected(s=>s.includes(n)?s.filter(x=>x!==n):[...s,n].sort((a,b)=>a-b));clearResult()};
  const all=()=>{setSelected(Array.from({length:pages},(_,i)=>i+1));clearResult()};
  const none=()=>{setSelected([]);clearResult()};
  const apply=()=>{const p=parsePages(range,pages);if(!p.length){setError("Usa formatos como 1, 3, 5-8.");return}setSelected(p);setError("");clearResult()};

  const preview=({n})=>{
    const [src,setSrc]=useState("");
    useEffect(()=>{let live=true;(async()=>{if(!pdf)return;try{const p=await pdf.getPage(n),v=p.getViewport({scale:.28}),c=document.createElement("canvas");c.width=Math.ceil(v.width);c.height=Math.ceil(v.height);await p.render({canvasContext:c.getContext("2d"),viewport:v}).promise;if(live)setSrc(c.toDataURL("image/jpeg",.7))}catch{}})();return()=>{live=false}},[pdf,n]);
    return <button type="button" className={`page-card ${selected.includes(n)?"selected":""}`} onClick={()=>toggle(n)} disabled={processing}>
      <span>Página {n}</span><div>{src?<img src={src} alt={`Página ${n}`}/>:<b>⏳</b>}{selected.includes(n)&&<i>✓</i>}</div>
    </button>
  };

  const wait=()=>new Promise(r=>setTimeout(r,0));
  const mime=format==="png"?"image/png":format==="webp"?"image/webp":"image/jpeg";
  const ext=format==="jpg"?"jpg":format;
  const base=(name)=>name.replace(/\.[^.]+$/,"");

  const pdfToImages=async()=>{
    if(!pdf)return;
    const list=selected.length?[...selected]:Array.from({length:pages},(_,i)=>i+1);
    const zip=new JSZip(); setProcessing(true);setCancel(false);setError("");setMessage("");clearResult();
    try{
      for(let i=0;i<list.length;i++){
        if(cancel)throw Error("CANCEL");
        const n=list[i];setCurrent(n);
        const p=await pdf.getPage(n), v=p.getViewport({scale:(dpi/72)*(scale/100)});
        const c=document.createElement("canvas");c.width=Math.ceil(v.width);c.height=Math.ceil(v.height);
        const ctx=c.getContext("2d",{alpha:format==="png"}); if(format!=="png"){ctx.fillStyle="#fff";ctx.fillRect(0,0,c.width,c.height)}
        await p.render({canvasContext:ctx,viewport:v}).promise;
        const data=c.toDataURL(mime,format==="png"?undefined:qualityMap[quality].value);
        zip.file(`${base(file.name)}-pagina-${String(n).padStart(3,"0")}.${ext}`,data.split(",")[1],{base64:true});
        setProgress(Math.round((i+1)/list.length*100));await wait();
      }
      const blob=await zip.generateAsync({type:"blob"});const url=URL.createObjectURL(blob);
      setDownload(url);setDownloadName(`${base(file.name)}-${ext}.zip`);setResultCount(list.length);setMessage("¡Conversión completada! El ZIP está listo para descargar.");setProgress(100);
    }catch(e){if(e.message==="CANCEL")setMessage("Conversión cancelada.");else{console.error(e);setError("No se pudo convertir el PDF.")}}
    finally{setProcessing(false);setCancel(false)}
  };

  const imageToPdf=async()=>{
    if(!images.length)return;
    setProcessing(true);setCancel(false);setError("");setMessage("");clearResult();
    try{
      const out=await PDFDocument.create();
      for(let i=0;i<images.length;i++){
        if(cancel)throw Error("CANCEL");setCurrent(i+1);
        const f=images[i],url=URL.createObjectURL(f),img=await new Promise((res,rej)=>{const x=new Image();x.onload=()=>res(x);x.onerror=rej;x.src=url});
        URL.revokeObjectURL(url);
        const c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0);
        const data=c.toDataURL("image/jpeg",.92),bytes=Uint8Array.from(atob(data.split(",")[1]),x=>x.charCodeAt(0)),jpg=await out.embedJpg(bytes);
        const p=out.addPage([jpg.width,jpg.height]);p.drawImage(jpg,{x:0,y:0,width:jpg.width,height:jpg.height});setProgress(Math.round((i+1)/images.length*100));await wait();
      }
      const blob=new Blob([await out.save({useObjectStreams:true})],{type:"application/pdf"}),url=URL.createObjectURL(blob);
      setDownload(url);setDownloadName(images.length===1?`${base(images[0].name)}.pdf`:"NovaPDF-imagenes.pdf");setResultCount(images.length);setMessage("¡PDF creado correctamente! Está listo para descargar.");
    }catch(e){if(e.message==="CANCEL")setMessage("Conversión cancelada.");else{console.error(e);setError("No se pudieron convertir las imágenes a PDF.")}}
    finally{setProcessing(false);setCancel(false)}
  };

  const start=()=>mode==="pdf"?pdfToImages():imageToPdf();

  const move=(to)=>{if(dragIndex===null)return;setImages(a=>{const b=[...a], [x]=b.splice(dragIndex,1);b.splice(to,0,x);return b});setDragIndex(null);clearResult()};

  return <section className="convert-page">
    <header className="convert-header"><div>🔄 Herramienta NovaPDF</div><h1>Convertir PDF</h1><p>Convierte PDF a JPG, PNG o WebP, o convierte imágenes en un PDF.</p></header>

    <div className="convert-mode"><button className={mode==="pdf"?"active":""} onClick={()=>changeMode("pdf")} disabled={processing}>📄 PDF → Imagen</button><button className={mode==="img"?"active":""} onClick={()=>changeMode("img")} disabled={processing}>🖼️ Imagen → PDF</button></div>

    <div className={`convert-upload ${drag?"dragging":""}`} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
      {!file&&!images.length?<><div className="upload-icon">{drag?"📥":mode==="pdf"?"📄":"🖼️"}</div><h2>{drag?"Suelta aquí":mode==="pdf"?"Selecciona tu PDF":"Selecciona tus imágenes"}</h2><p>Arrastra y suelta o utiliza el botón para seleccionar archivos.</p><button onClick={()=>input.current?.click()} disabled={processing}>📂 Seleccionar {mode==="pdf"?"PDF":"imágenes"}</button><input ref={input} type="file" className="hidden" multiple={mode==="img"} accept={mode==="pdf"?".pdf,application/pdf":".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"} onChange={inputChange}/></>:<div className="file-box"><span>{mode==="pdf"?"📄":"🖼️"}</span><div><strong>{mode==="pdf"?file?.name:`${images.length} imágenes seleccionadas`}</strong><small>{mode==="pdf"?`${size(file.size)} · ${pages} páginas`:`${size(images.reduce((a,f)=>a+f.size,0))} · arrastra para ordenar`}</small></div><button onClick={reset} disabled={processing}>🗑️</button></div>}
    </div>

    {error&&<div className="alert error">⚠️ {error}</div>}
    {message&&!error&&<div className="alert success">✅ {message}</div>}

    {mode==="pdf"&&file&&<div className="panel">
      <h2>Configuración de conversión</h2>
      <h3>Formato de salida</h3>
      <div className="format-grid">{[["jpg","🖼️","JPG","Ligero y compatible"],["png","🖼️","PNG","Alta calidad"],["webp","🌐","WebP","Moderno y ligero"]].map(x=><button key={x[0]} className={format===x[0]?"active":""} onClick={()=>{setFormat(x[0]);clearResult()}} disabled={processing}><b>{x[1]}</b><span><strong>{x[2]}</strong><small>{x[3]}</small></span>{format===x[0]&&<i>✓</i>}</button>)}</div>
      <div className="settings"><label>Calidad<select value={quality} onChange={e=>setQuality(e.target.value)} disabled={processing}>{Object.entries(qualityMap).map(([k,v])=><option key={k} value={k}>{v.name}{k==="medium"?" — recomendada":""}</option>)}</select></label><label>Resolución<select value={dpi} onChange={e=>setDpi(+e.target.value)} disabled={processing}>{[72,96,150,200,300].map(v=><option key={v} value={v}>{v} DPI</option>)}</select></label><label>Escala<select value={scale} onChange={e=>setScale(+e.target.value)} disabled={processing}>{[50,75,100,150,200].map(v=><option key={v} value={v}>{v} %</option>)}</select></label></div>
      <div className="selection-head"><div><h3>Páginas del documento</h3><small>{pages} totales · {selected.length||pages} a convertir</small></div><div><button onClick={all} disabled={processing}>✓ Todas</button><button onClick={none} disabled={processing}>Limpiar</button></div></div>
      <div className="range"><input value={range} onChange={e=>setRange(e.target.value)} onKeyDown={e=>e.key==="Enter"&&apply()} placeholder="Ej.: 1, 3, 5-8, 12"/><button onClick={apply}>Aplicar</button></div>
      <div className="summary">📋 <div><strong>Resumen de selección</strong><span>{selected.length?`${selected.length} seleccionadas · ${pageText(selected)}`:`Se convertirán las ${pages} páginas`}</span></div></div>
      <div className="page-grid">{Array.from({length:Math.min(visible,pages)},(_,i)=><Preview key={i+1} n={i+1}/>)}</div>
      {visible<pages&&<button className="secondary" onClick={()=>setVisible(v=>Math.min(v+8,pages))}>📄 Cargar más páginas</button>}
      <div className="info-grid"><span>Formato<strong>{format.toUpperCase()}</strong></span><span>Calidad<strong>{qualityMap[quality].name}</strong></span><span>Resolución<strong>{dpi} DPI</strong></span><span>Páginas<strong>{selected.length||pages}</strong></span></div>
      {processing&&<Progress text={`Convirtiendo página ${current} de ${selected.length||pages}`}/>}
      <button className="main-btn" onClick={start} disabled={processing}>{processing?"⏳ Procesando...":`🔄 Convertir PDF a ${format.toUpperCase()}`}</button>
    </div>}

    {mode==="img"&&images.length>0&&<div className="panel">
      <h2>Imágenes → PDF</h2><p>Arrastra cada archivo para cambiar el orden.</p>
      <div className="image-list">{images.map((f,i)=><div key={`${f.name}-${i}`} draggable={!processing} onDragStart={()=>setDragIndex(i)} onDragOver={e=>e.preventDefault()} onDrop={()=>move(i)} className="image-row"><span>☷</span><b>{i+1}</b><div><strong>{f.name}</strong><small>{size(f.size)}</small></div><button onClick={()=>{setImages(a=>a.filter((_,x)=>x!==i));clearResult()}} disabled={processing}>🗑️</button></div>)}</div>
      <button className="secondary" onClick={()=>input.current?.click()} disabled={processing}>➕ Agregar imágenes</button>
      {processing&&<Progress text={`Creando página ${current} de ${images.length}`}/>}
      <button className="main-btn" onClick={start} disabled={processing}>{processing?"⏳ Creando PDF...":"📄 Convertir imágenes a PDF"}</button>
    </div>}

    {download&&!processing&&<div className="result"><div>✅</div><h2>Conversión completada</h2><p>{resultCount} elementos procesados. El archivo está listo para descargar.</p><a href={download} download={downloadName}>⬇️ Descargar {downloadName.endsWith(".zip")?"ZIP":"PDF"}</a><button onClick={reset}>🔄 Convertir otro archivo</button></div>}
  </section>;

  function Progress({text}) {
    return <div className="progress"><div><span>{text}</span><strong>{progress}%</strong></div><section><i style={{width:`${progress}%`}}/></section><button onClick={()=>setCancel(true)}>✕ Cancelar conversión</button></div>;
  }
}

export default ConvertPDF;F;