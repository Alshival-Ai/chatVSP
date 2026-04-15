import { FileDescriptor } from "../interfaces";
import { ProjectFile } from "../projects/projectsService";

export function projectsFileToFileDescriptor(
  file: ProjectFile
): FileDescriptor {
  if (file.is_chat_file) {
    return {
      id: file.file_id,
      type: file.chat_file_type,
      name: file.name,
      is_chat_file: true,
    };
  }

  return {
    id: file.file_id,
    type: file.chat_file_type,
    name: file.name,
    user_file_id: file.id,
  };
}

export function projectFilesToFileDescriptors(
  files: ProjectFile[]
): FileDescriptor[] {
  return files.map(projectsFileToFileDescriptor);
}
