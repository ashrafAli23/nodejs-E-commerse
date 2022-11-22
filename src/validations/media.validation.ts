import Joi from "joi";
import { paginateDefault } from ".";
import { FileType, MediaType } from "../enum/media.enum";

const createFolder = {
  body: Joi.object().keys({
    parent_id: Joi.string(),
    name: Joi.string().required(),
    desc: Joi.string(),
    icon: Joi.string(),
  }),
};

const createFile = {
  body: Joi.object().keys({
    folder_id: Joi.string(),
    name: Joi.string().required(),
    desc: Joi.string(),
    icon: Joi.string(),
    url: Joi.string().required(),
    size_in_mb: Joi.number().required(),
    ext: Joi.string().required(),
    file_type: Joi.string()
      .required()
      .valid(...Object.values(FileType)),
  }),
};

const updateFolder = {
  params: Joi.object().keys({
    folder_id: Joi.string().required(),
  }),
  body: Joi.object()
    .keys({
      parent_id: Joi.string(),
      name: Joi.string(),
      desc: Joi.string(),
      icon: Joi.string(),
    })
    .min(1),
};

const updateFile = {
  params: Joi.object().keys({
    file_id: Joi.string().required(),
  }),
  body: Joi.object()
    .keys({
      folder_id: Joi.string(),
      name: Joi.string(),
      desc: Joi.string(),
      icon: Joi.string(),
    })
    .min(1),
};
const copy = {
  body: Joi.array().items(
    Joi.object().keys({
      type: Joi.string().valid("folder", "file"),
      id: Joi.string().required(),
      parent_id: Joi.string().required(),
    })
  ),
};

const move = {
  body: Joi.array().items(
    Joi.object().keys({
      type: Joi.string().valid("folder", "file"),
      id: Joi.string().required(),
      parent_id: Joi.string().required(),
    })
  ),
};

const deleteFolder = {
  params: Joi.object().keys({
    folder_id: Joi.string().required(),
  }),
};

const deleteFile = {
  params: Joi.object().keys({
    file_id: Joi.string().required(),
  }),
};

const findFolderById = {
  params: Joi.object().keys({
    folder_id: Joi.string().required(),
  }),
  body: Joi.object().keys({}),
  query: Joi.object().keys({}),
};

const findFileById = {
  params: Joi.object().keys({
    file_id: Joi.string().required(),
  }),
  body: Joi.object().keys({}),
  query: Joi.object().keys({}),
};

const homeMedia = {
  query: Joi.object().keys({
    media_type: Joi.string().valid(...Object.values(MediaType)),
    ...paginateDefault,
  }),
  body: Joi.object().keys({}),
};
const folderMedia = {
  params: Joi.object().keys({
    folder_id: Joi.string().required(),
  }),
  query: Joi.object().keys({
    media_type: Joi.string().valid(...Object.values(MediaType)),
    ...paginateDefault,
  }),
  body: Joi.object().keys({}),
};
const findAllNestedFolders = {
  params: Joi.object().keys({}),
  query: Joi.object().keys({
    folder_id: Joi.string(),
    include_files: Joi.boolean(),
  }),
  body: Joi.object().keys({}),
};

const getParentFolders = {
  params: Joi.object().keys({
    folder_id: Joi.string().required(),
  }),
  query: Joi.object().keys({
    direction: Joi.string(),
  }),
  body: Joi.object().keys({}),
};
const getChildrenFolders = {
  params: Joi.object().keys({
    folder_id: Joi.string().required(),
  }),
  query: Joi.object().keys({
    direction: Joi.string(),
  }),
  body: Joi.object().keys({}),
};

export default {
  createFolder,
  createFile,
  updateFolder,
  updateFile,
  copy,
  move,
  deleteFolder,
  deleteFile,
  findFolderById,
  findFileById,
  homeMedia,
  folderMedia,
  findAllNestedFolders,
  getParentFolders,
  getChildrenFolders,
};
