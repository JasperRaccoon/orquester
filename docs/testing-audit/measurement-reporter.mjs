export default async function* (source) {
  for await (const event of source) {
    if (['test:pass','test:fail','test:summary'].includes(event.type)) {
      const d=event.data;
      yield JSON.stringify({event:event.type,name:d.name,file:d.file,line:d.line,type:d.details?.type,duration_ms:d.details?.duration_ms ?? d.duration_ms,counts:d.counts,success:d.success,error:d.details?.error ? {message:d.details.error.message,stack:d.details.error.stack,cause:d.details.error.cause} : undefined})+'\n';
    }
  }
}
