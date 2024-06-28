import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { ProjectMetadataSimple } from "./types/projects";

async function downloadImage(
  url: string,
  folder: string,
  filename: string
): Promise<void> {
  try {
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
    });

    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    const filePath = path.resolve(folder, filename);
    const writer = fs.createWriteStream(filePath);

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    console.error("Error downloading the image", error);
  }
}

async function downloadAllImages() {
  const response = await axios.get('https://round4-api-eas.retrolist.app/projects')
  const projects: ProjectMetadataSimple[] = response.data

  for (const project of projects) {
    await downloadImage(`http://localhost:3001/api/retro4-voting?projectId=${project.id}`, 'og', project.id + '.png')
  }
}

downloadAllImages()
    .then(() => console.log('Image downloaded successfully'))
    .catch(err => console.error('Error downloading the image:', err));
