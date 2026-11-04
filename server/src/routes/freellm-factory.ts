import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { createProductSchema, productFactoryService } from "../adapters/freellm-browser/product-factory.js";

export function freellmFactoryRouter(db:Db){
  const router=Router(), factory=productFactoryService(db);
  router.use((req,_res,next)=>{assertBoard(req);assertInstanceAdmin(req);next();});
  router.get("/",async(req,res)=>{
    const companyId=z.string().uuid().parse(req.query.companyId); assertCompanyAccess(req,companyId);
    res.json(await factory.overview(companyId));
  });
  router.post("/teams",async(req,res)=>{
    const input=z.object({companyId:z.string().uuid(),catalogId:z.string().min(1),model:z.string().default("gemini-default")}).parse(req.body);
    assertCompanyAccess(req,input.companyId);
    res.status(201).json(await factory.installTeam(input.companyId,input.catalogId,input.model,req.actor.userId||"local-board"));
  });
  router.post("/products",async(req,res)=>{
    const input=createProductSchema.parse(req.body);assertCompanyAccess(req,input.companyId);
    res.status(201).json(await factory.createProduct(input,req.actor.userId||"local-board"));
  });
  return router;
}
