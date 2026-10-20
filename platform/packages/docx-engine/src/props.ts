/** 文档属性净化：脱敏件/对外件不得携带原作者姓名等元数据；保留生成标识。 */
import { dropHouseMark } from "./house-style.ts";
import { readZipEntries, writeZip } from "./zip.ts";

export function scrubDocProps(docx: Buffer, creator = "Kimi Work 法律行业发行版"): Buffer {
  const files = readZipEntries(docx);
  for (const name of ["docProps/core.xml", "docProps/app.xml"]) {
    const buf = files.get(name);
    if (!buf) continue;
    let xml = buf.toString("utf8");
    xml = xml.replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, `<dc:creator>${creator}</dc:creator>`);
    xml = xml.replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, "<cp:lastModifiedBy></cp:lastModifiedBy>");
    xml = xml.replace(/<Company>[\s\S]*?<\/Company>/, "<Company></Company>");
    xml = xml.replace(/<Manager>[\s\S]*?<\/Manager>/, "<Manager></Manager>");
    files.set(name, Buffer.from(xml, "utf8"));
  }
  dropHouseMark(files);
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}
