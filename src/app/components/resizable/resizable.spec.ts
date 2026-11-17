import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Resizable } from './resizable';

describe('Resizable', () => {
  let component: Resizable;
  let fixture: ComponentFixture<Resizable>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Resizable],
    }).compileComponents();

    fixture = TestBed.createComponent(Resizable);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
